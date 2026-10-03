import {
  NativeDOMException,
  canDefine,
  executionError,
  isObject,
  queueTask,
  toolNamePattern,
  type StoredTool,
  type ToolMetadata,
} from "./tools.js";

/** The tool map that declarative tools share with registerTool(), and its change notification. */
interface ToolHost {
  tools: Map<string, StoredTool>;
  changed(): void;
}

interface FormDefinition extends Pick<ToolMetadata, "name" | "title" | "description"> {
  autosubmit: boolean;
  serializedSchema: string;
  declaration: string;
}

interface PendingSubmission {
  form: HTMLFormElement;
  /** "submitting" lasts until the settlement task; the page's response may remain pending. */
  phase: "waiting" | "submitting" | "handled";
  response?: Promise<unknown>;
  resolve(result: unknown): void;
  reject(): void;
}

// Navigation resolves null; a null response serializes as "null".
const navigated = Symbol("navigated");
const submissions = new WeakMap<Event, PendingSubmission>();
const documentTools = new WeakMap<Document, DeclarativeTools>();

/**
 * Adds the explainer's SubmitEvent members, and lets form.submit() complete the form's tool calls.
 *
 * @throws {TypeError} If a prototype prevents installation; nothing is defined then.
 * @see https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md#events
 * @see https://webidl.spec.whatwg.org/#es-promise
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
      // Web IDL adopts the response into a fresh promise before the method's steps.
      const response = new Promise<unknown>((resolve) => resolve(agentResponse));
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
      // Prevent unhandledrejection before the settlement task observes the response.
      void response.catch(() => {});
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
      // submit() skips the submit event, so complete the form's running calls here.
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

/** Recognizes submissions even in capture listeners registered before the polyfill. */
function submissionOf(event: SubmitEvent): PendingSubmission | undefined {
  documentTools.get(document)?.submitting(event);
  return submissions.get(event);
}

/**
 * Maintains tool registrations and pending calls for forms that declare tools.
 *
 * @see https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md#processing-model
 * @see [Tracked sources and limitations](../TESTING.md#draft-alignment-and-limitations)
 */
export class DeclarativeTools {
  readonly #document: Document;
  readonly #host: ToolHost;
  readonly #registrations = new Map<HTMLFormElement, FormDefinition>();
  /** Responses may overlap, but only one call per form waits for submission. */
  readonly #pending = new Set<PendingSubmission>();

  constructor(view: Window, host: ToolHost) {
    this.#document = view.document;
    this.#host = host;
    documentTools.set(this.#document, this);
    // A reset counts only once the form's listeners could prevent it, so it is heard as it bubbles.
    view.addEventListener("reset", (event) => this.#resetting(event));
    // Labels and associated controls outside a form can change its schema.
    new MutationObserver(() => this.update()).observe(this.#document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: definingAttributes,
    });
    this.update();
  }

  /**
   * Frees names of removed or incomplete declarations before imperative registration.
   * Leaves other changes for update(), matching Chromium's deferred registration.
   */
  release(): void {
    if (this.#refreshRegistrations(true)) {
      this.#host.changed();
    }
  }

  update(): void {
    let changed = this.#refreshRegistrations();
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

  /** A waiting tool call owns the form's next trusted submission, including a user's. */
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

  #refreshRegistrations(removeOnly = false): boolean {
    let changed = false;
    for (const [form, registered] of this.#registrations) {
      // A form moved to another document or into a shadow tree is out of the observer's reach.
      const definition = this.#document.contains(form) ? readDefinition(form) : undefined;
      const sameDeclaration = definition?.declaration === registered.declaration;
      const unchanged =
        sameDeclaration && definition?.serializedSchema === registered.serializedSchema;
      if (definition && (removeOnly || unchanged)) {
        continue;
      }
      // Keep the name claimed while replacing the form's tool.
      if (definition?.name === registered.name) {
        this.#host.tools.set(definition.name, this.#createTool(form, definition));
        this.#registrations.set(form, definition);
      } else {
        this.#host.tools.delete(registered.name);
        this.#registrations.delete(form);
      }
      changed = true;
      // Schema changes replace the tool without canceling its calls.
      if (sameDeclaration) {
        continue;
      }
      for (const pending of this.#callsOf(form)) {
        // Observers see submit-handler mutations later, so preserve calls until settlement.
        if (pending.phase === "submitting") {
          continue;
        }
        pending.reject();
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

  #execute(
    form: HTMLFormElement,
    autosubmit: boolean,
    input: object,
    signal: AbortSignal,
    activate: () => void,
  ): Promise<unknown> {
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

      // The explainer puts toolactivated between filling and submitting; Chromium fires it after.
      activate();
      // A toolactivated listener may have settled the call or submitted the form itself.
      if (!this.#pending.has(pending) || pending.phase !== "waiting") {
        return;
      }
      // Filling and toolactivated listeners can replace or disable the submit button.
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
    // Close respondWith() even if reset or script submission already settled the call.
    pending.phase = "handled";
    if (!this.#pending.has(pending)) {
      return;
    }
    if (pending.response) {
      pending.response.then(pending.resolve, pending.reject);
      return;
    }
    if (event.defaultPrevented) {
      pending.reject();
      return;
    }
    pending.resolve(navigated);
  }

  #resetting(event: Event): void {
    if (!event.isTrusted || event.defaultPrevented) {
      return;
    }
    for (const pending of this.#callsOf(event.target)) {
      pending.reject();
    }
  }

  #callsOf(target: EventTarget | null): PendingSubmission[] {
    return [...this.#pending].filter((pending) => pending.form === target);
  }

  #waiting(target: EventTarget | null): PendingSubmission | undefined {
    return this.#callsOf(target).find((pending) => pending.phase === "waiting");
  }
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

type Parameter =
  | { kind: "checkbox" | "radio"; controls: [HTMLInputElement, ...HTMLInputElement[]] }
  | { kind: "select"; control: HTMLSelectElement }
  | { kind: "text"; control: HTMLInputElement | HTMLTextAreaElement }
  | {
      kind: "date" | "datetime-local" | "month" | "week" | "time" | "number" | "range" | "color";
      control: HTMLInputElement;
    };

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
  return stripWhitespace(name);
}

/**
 * Preserves the names and labels that Blink's StripWhiteSpace treats as distinct. String.trim()
 * would also strip non-breaking spaces, paragraph separators and BOMs.
 */
function stripWhitespace(value: string): string {
  return value.replace(
    /^[\t-\r \u1680\u2000-\u200a\u2028\u205f\u3000]+|[\t-\r \u1680\u2000-\u200a\u2028\u205f\u3000]+$/gu,
    "",
  );
}

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
  // SAFETY: the group is nonempty, and controlKind() establishes each kind's element types.
  return (isGroup ? { kind, controls } : { kind, control: controls[0] }) as Parameter;
}

function controlKind(element: Element): Parameter["kind"] | undefined {
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

/** Preserves authored month/week types when the browser reflects unsupported types as text. */
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

/**
 * HTML patterns use Unicode sets syntax, so validation requires the v flag.
 * @see https://html.spec.whatwg.org/multipage/input.html#attr-input-pattern
 */
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

/** @see https://html.spec.whatwg.org/multipage/input.html#range-state-(type=range) */
function rangeLimits(control: Element): object {
  const minimum = parseNumber(control.getAttribute("min")) ?? 0;
  const maximum = Math.max(parseNumber(control.getAttribute("max")) ?? 100, minimum);
  return { minimum, maximum };
}

/** multipleOf cannot express HTML's step offset unless the base is also a multiple of the step. */
function multipleOf(control: HTMLInputElement): { multipleOf?: number } {
  const isRange = control.type === "range";
  const step = parseStep(control, 1) ?? (isRange ? 1 : undefined);
  if (step === undefined) {
    return {};
  }
  const stepAttribute = control.getAttribute("step");
  const stepText =
    stepAttribute !== null && parseNumber(stepAttribute) === step ? stepAttribute : String(step);
  return isMultiple(stepBase(control), stepText) ? { multipleOf: step } : {};
}

/** Suggests the time precision accepted by the control's step, matching Chromium's schema. */
function secondsPattern(control: Element): string {
  const step = Math.max(Math.round((parseStep(control, 60) ?? 60) * 1000), 1);
  if (step < 1000) {
    return "(:[0-5][0-9](\\.[0-9]{1,3})?)?";
  }
  return step < 60000 ? "(:[0-5][0-9])?" : "";
}

/**
 * @returns undefined for step="any".
 * @see https://html.spec.whatwg.org/multipage/input.html#concept-input-step
 */
function parseStep(control: Element, defaultStep: number): number | undefined {
  const value = control.getAttribute("step");
  if (value?.toLowerCase() === "any") {
    return undefined;
  }
  const step = parseNumber(value);
  return step !== undefined && step > 0 ? step : defaultStep;
}

/**
 * Keeps raw attribute text for exact decimal divisibility checks.
 * @see https://html.spec.whatwg.org/multipage/input.html#concept-input-min-zero
 */
function stepBase(control: Element): string {
  return (
    [control.getAttribute("min"), control.getAttribute("value")].find(
      (value) => parseNumber(value) !== undefined,
    ) ?? "0"
  );
}

/** Checks divisibility before Number conversion can round away a decimal remainder. */
function isMultiple(value: string, step: string): boolean {
  const base = decimalParts(value);
  const increment = decimalParts(step);
  if (!base || !increment) {
    return false;
  }
  const commonExponent = Math.min(base.exponent, increment.exponent);
  const dividend = base.coefficient * 10n ** BigInt(base.exponent - commonExponent);
  const divisor = increment.coefficient * 10n ** BigInt(increment.exponent - commonExponent);
  return dividend % divisor === 0n;
}

function decimalParts(value: string): { coefficient: bigint; exponent: number } | undefined {
  const [significand = "", exponentText = "0"] = value.toLowerCase().split("e");
  const fractionLength = significand.split(".")[1]?.length ?? 0;
  const coefficientText = significand.replace(".", "").replace(/^(-?)0+(?=\d)/u, "$1");
  const exponent = Number(exponentText) - fractionLength;
  // Omit constraints that would require Blink's Decimal rounding beyond these bounds.
  if (coefficientText.replace("-", "").length > 18 || Math.abs(exponent) > 1023) {
    return undefined;
  }
  return { coefficient: BigInt(coefficientText), exponent };
}

/**
 * HTML numeric syntax excludes some strings that Number() accepts.
 * @see https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-floating-point-number
 */
function parseNumber(value: string | null): number | undefined {
  if (value === null || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/u.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parameterDescription(parameter: Parameter): string | undefined {
  if ("controls" in parameter && parameter.controls.length > 1) {
    // A group is described only by the nearest fieldset around all of its controls.
    return commonFieldset(parameter.controls)?.getAttribute("toolparamdescription") || undefined;
  }
  const control = "controls" in parameter ? parameter.controls[0] : parameter.control;
  return (
    control.getAttribute("toolparamdescription") ||
    labelText(control) ||
    control.getAttribute("aria-description") ||
    undefined
  );
}

function commonFieldset(
  controls: [FormControl, ...FormControl[]],
): HTMLFieldSetElement | undefined {
  const [first] = controls;
  let ancestor: Element | null = first;
  // Either climb can reach a form whose named controls shadow parentElement or contains.
  for (const control of controls) {
    while (ancestor && !Node.prototype.contains.call(ancestor, control)) {
      // SAFETY: parentElement is an Element or null.
      ancestor = Reflect.get(Node.prototype, "parentElement", ancestor) as Element | null;
    }
  }
  const form = first.form;
  while (ancestor && ancestor !== form) {
    if (isHTML(ancestor, "fieldset")) {
      return ancestor;
    }
    ancestor = Reflect.get(Node.prototype, "parentElement", ancestor) as Element | null;
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
    return stripWhitespace(text);
  }).join("; ");
}

/** @see https://html.spec.whatwg.org/multipage/forms.html#category-label */
function isLabelable(element: Element): boolean {
  if (isHTML(element, "input")) {
    return element.type !== "hidden";
  }
  const labelable = ["button", "meter", "output", "progress", "select", "textarea"] as const;
  return labelable.some((name) => isHTML(element, name)) || isFormAssociatedCustom(element);
}

/**
 * Validates every value before changing any control, so invalid input cannot partly fill the form.
 * Writes follow input key order, which the page's input and change listeners can observe.
 */
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
      return parameter.controls.length === 1
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
      // Chromium rejects empty values for numeric tool parameters.
      const text = toText(value);
      if (!text || !acceptsValue(control, text)) {
        return undefined;
      }
      return () => setValue(control, text);
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

/** Fires change even for unchanged checkboxes and radios, matching Chromium's tool filling. */
function setChecked(control: HTMLInputElement, checked: boolean): void {
  const before = control.checked;
  setProperty(control, HTMLInputElement.prototype, "checked", checked);
  if (control.checked !== before) {
    dispatchInputAndChange(control);
    return;
  }
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function dispatchInputAndChange(control: Element): void {
  control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Uses native value sanitization to check input without changing the live form. */
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

/** @see https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-month-string */
function isValidMonth(text: string): boolean {
  const [, year, month] = /^(\d{4,})-(\d{2})$/u.exec(text) ?? [];
  return Number(year) > 0 && Number(month) >= 1 && Number(month) <= 12;
}

/** @see https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-week-string */
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

function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

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

/** Produces "undefined" when JSON serialization returns undefined, as V8's JSON::Stringify does. */
function serializeResponse(response: unknown): string {
  return String(isObject(response) ? JSON.stringify(response) : response);
}

/**
 * Reads form members that named controls may shadow on the instance.
 * @see https://webidl.spec.whatwg.org/#LegacyOverrideBuiltIns
 */
function formMember<Name extends keyof HTMLFormElement>(
  form: HTMLFormElement,
  name: Name,
): HTMLFormElement[Name] {
  // SAFETY: the prototype chain holds the member that the form's named properties would shadow.
  return Reflect.get(HTMLFormElement.prototype, name, form) as HTMLFormElement[Name];
}

/** Searches the document because form.elements omits image buttons. */
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

/**
 * Native matching uses the form association captured when the element was defined.
 * @see https://html.spec.whatwg.org/multipage/semantics-other.html#selector-enabled
 */
function isFormAssociatedCustom(element: Element): boolean {
  // Match first: a form may shadow both matches and localName with named controls.
  return (
    Element.prototype.matches.call(element, ":enabled, :disabled") &&
    element.localName.includes("-")
  );
}

const htmlNamespace = "http://www.w3.org/1999/xhtml";

/** Identifies HTML elements across windows; instanceof fails for adopted nodes. */
function isHTML<Name extends keyof HTMLElementTagNameMap>(
  element: Element,
  name: Name,
): element is HTMLElementTagNameMap[Name] {
  // SAFETY: an HTML element with this local name implements the named interface.
  return element.namespaceURI === htmlNamespace && element.localName === name;
}

/** Bypasses framework value trackers so they detect the change when the input event arrives. */
function setProperty<
  Control extends Element,
  Name extends keyof Control & ("value" | "checked" | "selected"),
>(
  element: Control,
  prototype: object,
  name: Name,
  value: Control[Name],
): void {
  // SAFETY: callers name value, checked or selected, accessors with setters on these prototypes.
  Object.getOwnPropertyDescriptor(prototype, name)!.set!.call(element, value);
}
