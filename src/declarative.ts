import {
  NativeDOMException,
  canDefine,
  executionError,
  isObject,
  queueTask,
  toolNamePattern,
  type StoredTool,
} from "./tools.js";

/** The tool map that declarative tools share with registerTool(), and its change notification. */
interface ToolHost {
  tools: Map<string, StoredTool>;
  changed(): void;
}

interface FormDefinition {
  name: string;
  title: string;
  description: string;
  autosubmit: boolean;
  serializedSchema: string;
  declaration: string;
}

interface PendingSubmission {
  form: HTMLFormElement;
  // Waiting for the form's submission, then submitting from the agent's submit event until the
  // polyfill settles it in a later task. The call may then still wait for the page's response.
  phase: "waiting" | "submitting" | "handled";
  response?: Promise<unknown>;
  resolve(result: unknown): void;
  reject(): void;
}

// A submitted form navigates instead of responding; executeTool() then resolves null.
const navigated = Symbol("navigated");
const submissions = new WeakMap<Event, PendingSubmission>();
const documentTools = new WeakMap<Document, DeclarativeTools>();

/**
 * Adds the explainer's SubmitEvent members, and lets form.submit() complete the form's tool calls.
 *
 * @throws {TypeError} If a prototype prevents installation; nothing is defined then.
 * @see https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md
 */
export function installDeclarative(): void {
  const patches: [object, string][] = [
    [SubmitEvent.prototype, "agentInvoked"],
    [SubmitEvent.prototype, "respondWith"],
    [HTMLFormElement.prototype, "submit"],
  ];
  if (!patches.every(([target, name]) => canDefine(target, name))) {
    throw new TypeError("Cannot install WebMCP on this realm");
  }

  const getSubmitter = Object.getOwnPropertyDescriptor(SubmitEvent.prototype, "submitter")!.get!;
  // A method is non-constructible; the submitter getter supplies the native brand check.
  const { agentInvoked, respondWith } = {
    agentInvoked(this: SubmitEvent): boolean {
      getSubmitter.call(this);
      return submissionOf(this) !== undefined;
    },
    respondWith(this: SubmitEvent, agentResponse: unknown): void {
      getSubmitter.call(this);
      if (arguments.length < 1) {
        throw new TypeError("respondWith() requires a response");
      }
      // Web IDL converts the argument to a promise before the method's steps.
      const response = Promise.resolve(agentResponse);
      const submission = submissionOf(this);
      // Chromium's checks, in its order: agent-invoked, canceled, still dispatching. The polyfill
      // settles a submission in a later task, so a listener may respond after awaiting.
      if (!submission) {
        throw new NativeDOMException(
          "Only a submission caused by an agent can respond to it",
          "InvalidStateError",
        );
      }
      if (!this.defaultPrevented) {
        throw new NativeDOMException(
          "Call preventDefault() before respondWith()",
          "InvalidStateError",
        );
      }
      if (submission.phase !== "submitting") {
        throw new NativeDOMException(
          "The submission has already been handled",
          "InvalidStateError",
        );
      }
      submission.response = response;
    },
  };
  Object.defineProperty(agentInvoked, "name", { value: "get agentInvoked" });
  Object.defineProperties(SubmitEvent.prototype, {
    agentInvoked: { get: agentInvoked, enumerable: true, configurable: true },
    respondWith: { value: respondWith, writable: true, enumerable: true, configurable: true },
  });

  const nativeSubmit = HTMLFormElement.prototype.submit;
  const { submit } = {
    submit(this: HTMLFormElement): void {
      nativeSubmit.call(this);
      // As in Chromium, submitting a form from script completes its running tool calls.
      documentTools.get(formMember(this, "ownerDocument"))?.submitted(this);
    },
  };
  Object.defineProperty(HTMLFormElement.prototype, "submit", {
    value: submit,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // Capturing at installation marks an agent's submission before any listener the page adds later.
  addEventListener("submit", (event) => documentTools.get(document)?.submitting(event), true);
}

// A capture listener that the page added before installation runs before the polyfill's own,
// so the event's members also recognize an agent's submission.
function submissionOf(event: SubmitEvent): PendingSubmission | undefined {
  documentTools.get(document)?.submitting(event);
  return submissions.get(event);
}

/**
 * Declarative tools: forms with `toolname` and `tooldescription` attributes.
 *
 * The draft's declarative section is a TODO, so this follows the declarative API explainer
 * and Chromium's form_mcp_schema.cc and html_form_element.cc at dbdbb13fd74c.
 */
export class DeclarativeTools {
  readonly #document: Document;
  readonly #host: ToolHost;
  // The definition each form registered, while it holds that name in the host's map.
  readonly #registrations = new Map<HTMLFormElement, FormDefinition>();
  // Unfinished calls. A form has at most one call that waits for its submission.
  readonly #pending = new Set<PendingSubmission>();

  constructor(view: Window, host: ToolHost) {
    this.#document = view.document;
    this.#host = host;
    documentTools.set(this.#document, this);
    // A reset counts only once the form's listeners could prevent it, so it is heard as it bubbles.
    view.addEventListener("reset", (event) => this.#resetting(event));
    // Each mutation batch rereads every form, not only those the records touched.
    new MutationObserver(() => this.update()).observe(this.#document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: definingAttributes,
    });
    this.update();
  }

  // Unregisters forms that left the document or lost a tool attribute. Chromium does this
  // synchronously, so script can reuse their names before mutation observers run; it replaces
  // other changed forms in a later task.
  release(): void {
    if (this.#release(true)) {
      this.#host.changed();
    }
  }

  // Registers forms that became tools and replaces or removes those that changed.
  update(): void {
    let changed = this.#release();
    // The first form to claim a free name holds it, in document order.
    for (const form of this.#document.forms) {
      if (this.#registrations.has(form)) {
        continue;
      }
      const definition = readDefinition(form);
      // Chromium checks the name only when it registers the form, so release() keeps a form
      // renamed to an invalid name until then.
      if (
        !definition ||
        !toolNamePattern.test(definition.name) ||
        this.#host.tools.has(definition.name)
      ) {
        continue;
      }
      this.#host.tools.set(definition.name, this.#createTool(form, definition));
      this.#registrations.set(form, definition);
      changed = true;
    }
    if (changed) {
      this.#host.changed();
    }
  }

  submitted(form: HTMLFormElement): void {
    for (const pending of this.#callsOf(form)) {
      pending.resolve(navigated);
    }
  }

  // Chromium treats every trusted submission of a waiting form as the agent's. An event can
  // become one only once, and only while it is being dispatched.
  submitting(event: Event): void {
    if (!event.isTrusted || event.eventPhase === Event.NONE || submissions.has(event)) {
      return;
    }
    const pending = this.#waiting(event.target);
    // A shadow tree's submission never reaches the window listener, so it is not the agent's.
    if (!pending || !this.#document.contains(pending.form)) {
      return;
    }
    submissions.set(event, pending);
    pending.phase = "submitting";
    // The page's listeners, and the microtasks they queue, run before this task.
    queueTask(() => this.#settle(pending, event));
  }

  #release(onlyInvalid = false): boolean {
    let changed = false;
    for (const [form, registered] of this.#registrations) {
      // A form moved to another document or into a shadow tree is out of the observer's reach.
      const definition = this.#document.contains(form) ? readDefinition(form) : undefined;
      const sameDeclaration = definition?.declaration === registered.declaration;
      const unchanged =
        sameDeclaration && definition?.serializedSchema === registered.serializedSchema;
      if (onlyInvalid ? definition !== undefined : unchanged) {
        continue;
      }
      // Chromium replaces a changed form's tool in one task, so a form that keeps its name keeps
      // the tool.
      if (definition?.name === registered.name) {
        this.#host.tools.set(definition.name, this.#createTool(form, definition));
        this.#registrations.set(form, definition);
      } else {
        this.#host.tools.delete(registered.name);
        this.#registrations.delete(form);
      }
      changed = true;
      // Removal and tool attribute changes cancel the form's calls, as in the explainer; a schema
      // change only replaces the tool. Chromium keeps a call whose form changes during the agent's
      // submit event; the polyfill notices those changes later, so it keeps a submitting call.
      if (!sameDeclaration) {
        for (const pending of this.#callsOf(form)) {
          if (pending.phase !== "submitting") {
            pending.reject();
          }
        }
      }
    }
    return changed;
  }

  #createTool(form: HTMLFormElement, definition: FormDefinition): StoredTool {
    const { name, title, description, autosubmit, serializedSchema } = definition;
    return {
      metadata: { name, title, description, annotations: undefined, serializedSchema },
      exposedTo: [],
      run: (input, signal, activate) => this.#execute(form, autosubmit, input, signal, activate),
      serialize: (result) => (result === navigated ? null : serializeResponse(result)),
    };
  }

  // toolactivated fires between filling and submitting, as the explainer describes; Chromium
  // fires it after submitting.
  #execute(
    form: HTMLFormElement,
    autosubmit: boolean,
    input: object,
    signal: AbortSignal,
    activate: () => void,
  ): Promise<unknown> {
    // Chromium's input is a JSON object, and without autosubmit the user submits with a button.
    if (Array.isArray(input) || (!autosubmit && !defaultButton(this.#document, form))) {
      throw executionError();
    }
    fillForm(form, input);

    return new Promise((resolve, reject) => {
      const pending: PendingSubmission = {
        form,
        phase: "waiting",
        resolve: (result) => {
          this.#pending.delete(pending);
          resolve(result);
        },
        reject: () => {
          this.#pending.delete(pending);
          reject(executionError());
        },
      };
      // A newer call rejects one that still waits for the user; Chromium leaves it pending.
      this.#waiting(form)?.reject();
      this.#pending.add(pending);
      signal.addEventListener("abort", () => pending.reject(), { once: true });

      activate();
      // A toolactivated listener may have settled the call or submitted the form itself.
      if (!this.#pending.has(pending) || pending.phase !== "waiting") {
        return;
      }
      // Listeners may have replaced or disabled the button while the form was filled.
      const submitter = defaultButton(this.#document, form);
      if (!autosubmit) {
        submitter?.focus();
        return;
      }
      formMember(form, "requestSubmit").call(form, submitter ?? null);
      // A form that fails validation, or cannot submit for another reason, fires no submit event.
      if (pending.phase === "waiting") {
        pending.reject();
      }
    });
  }

  #settle(pending: PendingSubmission, event: Event): void {
    // Until now, respondWith() works even after a listener resets the form or submits it from
    // script; Chromium also accepts that response during dispatch, then ignores it.
    pending.phase = "handled";
    if (!this.#pending.has(pending)) {
      return;
    }
    if (pending.response) {
      pending.response.then(pending.resolve, pending.reject);
    } else if (event.defaultPrevented) {
      pending.reject();
    } else {
      pending.resolve(navigated);
    }
  }

  #resetting(event: Event): void {
    if (event.isTrusted && !event.defaultPrevented) {
      for (const pending of this.#callsOf(event.target)) {
        pending.reject();
      }
    }
  }

  #callsOf(target: EventTarget | null): PendingSubmission[] {
    return [...this.#pending].filter((pending) => pending.form === target);
  }

  #waiting(target: EventTarget | null): PendingSubmission | undefined {
    return this.#callsOf(target).find((pending) => pending.phase === "waiting");
  }
}

type ControlKind =
  | "text"
  | "date"
  | "datetime-local"
  | "month"
  | "week"
  | "time"
  | "number"
  | "range"
  | "checkbox"
  | "radio"
  | "color"
  | "select";

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

type Parameter =
  | { kind: "checkbox" | "radio"; controls: HTMLInputElement[] }
  | { kind: "select"; control: HTMLSelectElement }
  | {
      kind: Exclude<ControlKind, "checkbox" | "radio" | "select">;
      control: HTMLInputElement | HTMLTextAreaElement;
    };

// Attributes that can change a form's tool definition; text changes can too (labels, options).
const definingAttributes = [
  "toolname",
  "tooldescription",
  "tooltitle",
  "toolautosubmit",
  "toolparamdescription",
  "aria-description",
  "name",
  "type",
  "required",
  "disabled",
  "readonly",
  "multiple",
  "pattern",
  "min",
  "max",
  "step",
  "value",
  "form",
  "id",
  "for",
];

function readDefinition(form: HTMLFormElement): FormDefinition | undefined {
  const attribute = (name: string) => formMember(form, "getAttribute").call(form, name);
  const name = attribute("toolname");
  const description = attribute("tooldescription");
  // Chromium requires both attributes to be present; an empty description is allowed.
  if (name === null || description === null) {
    return undefined;
  }
  const title = attribute("tooltitle") ?? "";
  const autosubmit = attribute("toolautosubmit") !== null;
  return {
    name,
    title,
    description,
    autosubmit,
    serializedSchema: JSON.stringify(inputSchema(form)),
    declaration: JSON.stringify([name, title, description, autosubmit]),
  };
}

// Properties keep the order in which their names first appear, as in Chromium.
function inputSchema(form: HTMLFormElement): object {
  const properties = new Map<string, object>();
  const required: string[] = [];
  for (const [name, controls] of controlsByName(form)) {
    const parameter = readParameter(controls);
    if (!parameter) {
      continue;
    }
    properties.set(name, parameterSchema(parameter));
    if (controls.some((control) => control.hasAttribute("required"))) {
      required.push(name);
    }
  }
  // fromEntries keeps a parameter named "__proto__" an own property.
  return { type: "object", properties: Object.fromEntries(properties), required };
}

function controlsByName(form: HTMLFormElement): Map<string, Element[]> {
  const groups = new Map<string, Element[]>();
  for (const element of formMember(form, "elements")) {
    const name = parameterName(element);
    if (name === undefined) {
      continue;
    }
    const controls = groups.get(name);
    if (controls) {
      controls.push(element);
    } else {
      groups.set(name, [element]);
    }
  }
  return groups;
}

function parameterName(element: Element): string | undefined {
  const name = element.getAttribute("name") ?? "";
  if (isFormAssociatedCustom(element)) {
    // Form-associated custom elements join by their untrimmed name, even when disabled.
    return name || undefined;
  }
  if (isHTML(element, "object") || isDisabledOrReadOnly(element)) {
    return undefined;
  }
  return name.trim();
}

// Input types to which the readonly attribute applies.
const readOnlyTypes = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
]);

// Chromium skips disabled controls, and readonly ones where readonly applies.
function isDisabledOrReadOnly(element: Element): boolean {
  if (element.matches(":disabled")) {
    return true;
  }
  if (!element.hasAttribute("readonly")) {
    return false;
  }
  return (
    isHTML(element, "textarea") || (isHTML(element, "input") && readOnlyTypes.has(element.type))
  );
}

// A parameter is one control of a supported kind, or a group of only checkboxes or radios.
function readParameter(controls: Element[]): Parameter | undefined {
  const kinds = new Set(controls.map(controlKind));
  const [kind] = kinds;
  if (kinds.size !== 1 || !kind) {
    return undefined;
  }
  const isGroup = kind === "checkbox" || kind === "radio";
  if (!isGroup && controls.length !== 1) {
    return undefined;
  }
  // SAFETY: controlKind() gives each kind only to the element types Parameter declares for it.
  return (isGroup ? { kind, controls } : { kind, control: controls[0] }) as Parameter;
}

function controlKind(element: Element): ControlKind | undefined {
  if (isHTML(element, "textarea")) {
    return "text";
  }
  if (isHTML(element, "select")) {
    return "select";
  }
  if (!isHTML(element, "input")) {
    return undefined;
  }
  const type = inputType(element);
  switch (type) {
    case "text":
    case "email":
    case "search":
    case "tel":
    case "url":
    case "password":
      return "text";
    case "hidden":
      // A hidden input is a parameter only when the page describes it.
      return element.getAttribute("toolparamdescription") ? "text" : undefined;
    case "date":
    case "datetime-local":
    case "month":
    case "week":
    case "time":
    case "number":
    case "range":
    case "checkbox":
    case "radio":
    case "color":
      return type;
    default:
      return undefined;
  }
}

// Firefox and Safari have no month or week inputs, but the author's type still applies.
function inputType(input: HTMLInputElement): string {
  const type = input.getAttribute("type")?.toLowerCase();
  return type === "month" || type === "week" ? type : input.type;
}

function parameterSchema(parameter: Parameter): object {
  const schema = valueSchema(parameter);
  let description = parameterDescription(parameter);
  if (parameter.kind === "date") {
    const note = "Dates MUST be provided in 'YYYY-MM-DD' format.";
    description = description ? `${description} (${note})` : note;
  }
  return description ? { ...schema, description } : schema;
}

const timePattern = "([01][0-9]|2[0-3]):[0-5][0-9]";

function valueSchema(parameter: Parameter): object {
  switch (parameter.kind) {
    case "text":
      return { type: "string", ...patternOf(parameter.control) };
    case "date":
      return { type: "string", format: "date" };
    case "datetime-local": {
      const seconds = secondsPattern(parameter.control);
      return {
        type: "string",
        format: `^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T${timePattern}${seconds}$`,
      };
    }
    case "month":
      return { type: "string", format: "^[0-9]{4}-(0[1-9]|1[0-2])$" };
    case "week":
      return { type: "string", format: "^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$" };
    case "time":
      return { type: "string", format: `^${timePattern}${secondsPattern(parameter.control)}$` };
    case "number":
      return {
        type: "number",
        ...numberLimits(parameter.control),
        ...multipleOf(parameter.control),
        ...patternOf(parameter.control),
      };
    case "range":
      return {
        type: "number",
        ...rangeLimits(parameter.control),
        ...multipleOf(parameter.control),
      };
    case "color":
      // Chromium's pattern accepts any letter, although only hexadecimal digits are colors.
      return { type: "string", format: "^#[0-9a-zA-Z]{6}$" };
    case "checkbox":
      if (parameter.controls.length === 1) {
        return { type: "boolean" };
      }
      return arrayOf(choices(parameter.controls));
    case "radio":
      return choices(parameter.controls);
    case "select": {
      const { control } = parameter;
      const options = Array.from(control.options, (option) => ({
        const: option.value,
        title: option.textContent,
      }));
      return control.multiple ? arrayOf(enumOf(options)) : enumOf(options);
    }
  }
}

function choices(inputs: HTMLInputElement[]): object {
  return enumOf(
    inputs.map((input) => {
      const title = labelText(input);
      return title ? { const: input.value, title } : { const: input.value };
    }),
  );
}

function enumOf(options: { const: string; title?: string | null }[]): object {
  return {
    type: "string",
    anyOf: options.map((option) => ({ type: "string", ...option })),
    enum: options.map((option) => option.const),
  };
}

function arrayOf(items: object): object {
  return { type: "array", items, uniqueItems: true };
}

// Chromium includes a pattern only on input elements, and only if it compiles with the v flag.
function patternOf(control: Element): { pattern?: string } {
  const pattern = isHTML(control, "input") ? control.getAttribute("pattern") : null;
  if (pattern === null) {
    return {};
  }
  try {
    new RegExp(pattern, "v");
  } catch {
    return {};
  }
  return { pattern };
}

function numberLimits(control: Element): object {
  const minimum = parseNumber(control.getAttribute("min"));
  const maximum = parseNumber(control.getAttribute("max"));
  return {
    ...(minimum !== undefined && { minimum }),
    ...(maximum !== undefined && { maximum }),
  };
}

// https://html.spec.whatwg.org/multipage/input.html#range-state-(type=range)
function rangeLimits(control: Element): object {
  const minimum = parseNumber(control.getAttribute("min")) ?? 0;
  const maximum = Math.max(parseNumber(control.getAttribute("max")) ?? 100, minimum);
  return { minimum, maximum };
}

// Chromium states the step only when the step base is also a multiple of it.
function multipleOf(control: Element): { multipleOf?: number } {
  const step = parseStep(control, 1);
  return step !== undefined && isMultiple(stepBase(control), step) ? { multipleOf: step } : {};
}

// Chromium varies the time formats with the step to suggest the precision it accepts. It rounds
// the step to whole milliseconds, at least one, and treats "any" as the default minute.
function secondsPattern(control: Element): string {
  const step = Math.max(Math.round((parseStep(control, 60) ?? 60) * 1000), 1);
  if (step < 1000) {
    return "(:[0-5][0-9](\\.[0-9]{1,3})?)?";
  }
  return step < 60000 ? "(:[0-5][0-9])?" : "";
}

function parameterDescription(parameter: Parameter): string | undefined {
  const controls: FormControl[] =
    "controls" in parameter ? parameter.controls : [parameter.control];
  const [control] = controls;
  if (control && controls.length === 1) {
    return (
      control.getAttribute("toolparamdescription") ||
      labelText(control) ||
      control.getAttribute("aria-description") ||
      undefined
    );
  }
  // A group is described only by the nearest fieldset around all of its controls.
  return commonFieldset(controls)?.getAttribute("toolparamdescription") || undefined;
}

function commonFieldset(controls: FormControl[]): HTMLFieldSetElement | undefined {
  const [first] = controls;
  let ancestor: Element | null = first ?? null;
  for (const control of controls) {
    // The ancestor can be the form, whose controls may shadow the members it inherits from Node.
    while (ancestor && !Node.prototype.contains.call(ancestor, control)) {
      // SAFETY: parentElement is an Element or null.
      ancestor = Reflect.get(Node.prototype, "parentElement", ancestor) as Element | null;
    }
  }
  const form = first?.form;
  for (let element = ancestor; element && element !== form; element = element.parentElement) {
    if (isHTML(element, "fieldset")) {
      return element;
    }
  }
  return undefined;
}

// Text inside a nested control, such as a select's options, describes that control instead.
function labelText(control: FormControl): string {
  return Array.from(control.labels ?? [], (label) => {
    let text = "";
    const walker = label.ownerDocument.createTreeWalker(
      label,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      (node) =>
        // SAFETY: a node of type ELEMENT_NODE is an Element in any window.
        node.nodeType === Node.ELEMENT_NODE && isLabelable(node as Element)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        // SAFETY: a node of type TEXT_NODE is a Text node in any window.
        text += (node as Text).data;
      }
    }
    return text.trim();
  }).join("; ");
}

// https://html.spec.whatwg.org/multipage/forms.html#category-label
function isLabelable(element: Element): boolean {
  if (isHTML(element, "input")) {
    return element.type !== "hidden";
  }
  const labelable = ["button", "meter", "output", "progress", "select", "textarea"] as const;
  return labelable.some((name) => isHTML(element, name)) || isFormAssociatedCustom(element);
}

// Chromium's FormMCPSchema::FillData: every value is checked before any control changes, and
// controls change in the input's key order.
function fillForm(form: HTMLFormElement, input: object): void {
  const groups = controlsByName(form);
  const writes = Object.entries(input).map(([name, value]) => {
    const controls = groups.get(name);
    const parameter = controls && readParameter(controls);
    const write = parameter && prepareWrite(parameter, value);
    if (!write) {
      throw executionError();
    }
    return write;
  });
  for (const write of writes) {
    write();
  }
}

function prepareWrite(parameter: Parameter, value: unknown): (() => void) | undefined {
  switch (parameter.kind) {
    case "checkbox": {
      const [checkbox] = parameter.controls;
      return checkbox && parameter.controls.length === 1
        ? checkboxWrite(checkbox, value)
        : choicesWrite(parameter.controls, value);
    }
    case "radio":
      return radioWrite(parameter.controls, value);
    case "select":
      return selectWrite(parameter.control, value);
    case "number":
    case "range": {
      const { control } = parameter;
      // Numbers cannot be cleared.
      const text = toText(value);
      return text && acceptsValue(control, text) ? () => setValue(control, text) : undefined;
    }
    default: {
      const { control } = parameter;
      const text = toText(value);
      if (text === undefined || (text !== "" && !acceptsValue(control, text))) {
        return undefined;
      }
      return () => setValue(control, text);
    }
  }
}

function checkboxWrite(control: HTMLInputElement, value: unknown): (() => void) | undefined {
  const checked = toBoolean(value);
  return checked === undefined ? undefined : () => setChecked(control, checked);
}

function choicesWrite(controls: HTMLInputElement[], value: unknown): (() => void) | undefined {
  const chosen = distinctChoices(value, controls.map((control) => control.value));
  if (!chosen) {
    return undefined;
  }
  return () => {
    for (const control of controls) {
      setChecked(control, chosen.has(control.value));
    }
  };
}

function radioWrite(controls: HTMLInputElement[], value: unknown): (() => void) | undefined {
  const text = toText(value);
  if (text === undefined || !controls.some((control) => control.value === text)) {
    return undefined;
  }
  return () => {
    for (const control of controls) {
      if (control.value === text) {
        setChecked(control, true);
      }
    }
  };
}

function selectWrite(select: HTMLSelectElement, value: unknown): (() => void) | undefined {
  const options = Array.from(select.options);
  if (select.multiple) {
    const chosen = distinctChoices(value, options.map((option) => option.value));
    if (!chosen) {
      return undefined;
    }
    return () => {
      if (options.every((option) => option.selected === chosen.has(option.value))) {
        return;
      }
      for (const option of options) {
        setProperty(option, HTMLOptionElement.prototype, "selected", chosen.has(option.value));
      }
      dispatchInputAndChange(select);
    };
  }
  const text = toText(value);
  const option = options.find((candidate) => candidate.value === text);
  if (!option) {
    return undefined;
  }
  return () => {
    const selectedIndex = select.selectedIndex;
    setProperty(option, HTMLOptionElement.prototype, "selected", true);
    if (select.selectedIndex !== selectedIndex) {
      dispatchInputAndChange(select);
    }
  };
}

function distinctChoices(value: unknown, allowed: string[]): Set<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const chosen = new Set<string>();
  for (const item of value) {
    const text = toText(item);
    if (text === undefined || !allowed.includes(text) || chosen.has(text)) {
      return undefined;
    }
    chosen.add(text);
  }
  return chosen;
}

function setValue(control: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = isHTML(control, "textarea")
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const before = control.value;
  setProperty(control, prototype, "value", text);
  if (control.value !== before && control.type !== "hidden") {
    dispatchInputAndChange(control);
  }
}

// Chromium fires change at a checkbox or radio even when its checkedness stays.
function setChecked(control: HTMLInputElement, checked: boolean): void {
  const before = control.checked;
  setProperty(control, HTMLInputElement.prototype, "checked", checked);
  if (control.checked !== before) {
    dispatchInputAndChange(control);
  } else {
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function dispatchInputAndChange(control: Element): void {
  control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

// Chromium's value sanitization check, on a detached input of the same type.
function acceptsValue(control: HTMLInputElement | HTMLTextAreaElement, text: string): boolean {
  if (!isHTML(control, "input")) {
    return true;
  }
  const type = inputType(control);
  const probe = control.ownerDocument.createElement("input");
  probe.setAttribute("type", type);
  if (probe.type !== type) {
    return type === "month" ? isValidMonth(text) : isValidWeek(text);
  }
  setProperty(probe, HTMLInputElement.prototype, "value", text);
  return probe.value !== "";
}

// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-month-string
function isValidMonth(text: string): boolean {
  const [, year, month] = /^(\d{4,})-(\d{2})$/u.exec(text) ?? [];
  return Number(year) > 0 && Number(month) >= 1 && Number(month) <= 12;
}

// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-week-string
function isValidWeek(text: string): boolean {
  const [, year, week] = /^(\d{4,})-W(\d{2})$/u.exec(text) ?? [];
  return Number(year) > 0 && Number(week) >= 1 && Number(week) <= weeksInYear(Number(year));
}

// A year has 53 weeks when it starts on a Thursday, or on a Wednesday in a leap year.
function weeksInYear(year: number): number {
  const start = new Date(0);
  start.setUTCFullYear(year, 0, 1);
  const weekday = start.getUTCDay();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return weekday === 4 || (weekday === 3 && leap) ? 53 : 52;
}

// https://html.spec.whatwg.org/multipage/input.html#concept-input-step
// Undefined means "any".
function parseStep(control: Element, defaultStep: number): number | undefined {
  const value = control.getAttribute("step");
  if (value?.toLowerCase() === "any") {
    return undefined;
  }
  const step = parseNumber(value);
  return step !== undefined && step > 0 ? step : defaultStep;
}

// https://html.spec.whatwg.org/multipage/input.html#concept-input-min-zero
function stepBase(control: Element): number {
  const minimum = parseNumber(control.getAttribute("min"));
  return minimum ?? parseNumber(control.getAttribute("value")) ?? 0;
}

// Chromium divides exact decimals; 12 significant digits absorb binary error for realistic steps.
function isMultiple(value: number, step: number): boolean {
  return Number.isInteger(Number((value / step).toPrecision(12)));
}

// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-floating-point-number
function parseNumber(value: string | null): number | undefined {
  if (value === null || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/u.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

// Chromium's ToString: strings, numbers and booleans.
function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

// Chromium's ToBoolean: booleans, integers, and "true", "false", "1" or "0" in any case.
function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value !== 0 : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.toLowerCase();
  if (text === "true" || text === "1") {
    return true;
  }
  return text === "false" || text === "0" ? false : undefined;
}

// Chromium stringifies an object response as JSON and converts any other value to a string.
// String() turns an object that JSON leaves undefined into "undefined", as V8's JSON::Stringify.
function serializeResponse(response: unknown): string {
  return String(isObject(response) ? JSON.stringify(response) : response);
}

// A control named like a form member shadows it on the form ([LegacyOverrideBuiltIns]).
function formMember<Name extends keyof HTMLFormElement>(
  form: HTMLFormElement,
  name: Name,
): HTMLFormElement[Name] {
  // SAFETY: the prototype chain holds the member that the form's named properties would shadow.
  return Reflect.get(HTMLFormElement.prototype, name, form) as HTMLFormElement[Name];
}

// The first enabled submit button in tree order: Chromium focuses it or submits with it.
// form.elements leaves out image buttons, so the search covers the document.
function defaultButton(
  owner: Document,
  form: HTMLFormElement,
): HTMLButtonElement | HTMLInputElement | undefined {
  const candidates = owner.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input");
  for (const candidate of candidates) {
    const isSubmitButton = candidate.type === "submit" || candidate.type === "image";
    if (candidate.form === form && isSubmitButton && !candidate.matches(":disabled")) {
      return candidate;
    }
  }
  return undefined;
}

// customElements.define() converts a constructor's formAssociated to a boolean.
function isFormAssociatedCustom(element: Element): boolean {
  const definition = customElements.get(element.localName);
  return definition !== undefined && Boolean(Reflect.get(definition, "formAssociated"));
}

const htmlNamespace = "http://www.w3.org/1999/xhtml";

// An element's local name identifies it in any window; instanceof fails for adopted nodes.
function isHTML<Name extends keyof HTMLElementTagNameMap>(
  element: Element,
  name: Name,
): element is HTMLElementTagNameMap[Name] {
  // SAFETY: an HTML element with this local name implements the named interface.
  return element.namespaceURI === htmlNamespace && element.localName === name;
}

// Prototype setters bypass page overrides and the value trackers of frameworks such as React,
// which then see the change when the input event arrives.
function setProperty(element: Element, prototype: object, name: string, value: unknown): void {
  // SAFETY: callers name value, checked or selected, accessors with setters on these prototypes.
  Object.getOwnPropertyDescriptor(prototype, name)!.set!.call(element, value);
}
