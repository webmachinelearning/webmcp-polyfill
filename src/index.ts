/*!
 * Copyright (c) 2026 WebMCP polyfill contributors
 * SPDX-License-Identifier: MIT
 */

import type { WebMCP } from "webmcp-types";
export type { WebMCP } from "webmcp-types";

// Detached windows may stop exposing these bindings.
const NativeDOMException = globalThis.DOMException;
const getWindow = Object.getOwnPropertyDescriptor(globalThis, "window")?.get;

interface StoredTool {
  metadata: Omit<WebMCP.RegisteredTool, "inputSchema">;
  // Snapshot at registration; parse a fresh copy for each discovery result.
  serializedSchema?: string;
  execute: WebMCP.ToolExecuteCallback<object>;
}

const contexts = new WeakMap<Document, ModelContextPolyfill>();

/**
 * Install document-local WebMCP in the current window.
 *
 * Does nothing outside a secure browser context or when `document.modelContext`
 * already exists, including partial native implementations. Call before registering
 * tools in each frame; repeated calls preserve existing contexts and registrations.
 *
 * @throws {TypeError} If the window or Document prototype prevents installation.
 * @example
 * import { installWebMCP } from "webmcp-polyfill";
 * installWebMCP();
 *
 * @see https://webmachinelearning.github.io/webmcp/#document-extension
 * @see https://github.com/webmachinelearning/webmcp-polyfill/blob/main/TESTING.md
 */
export function installWebMCP(): void {
  if (typeof document === "undefined" || !globalThis.isSecureContext) {
    return;
  }
  if ("modelContext" in document) {
    return;
  }

  const documentPrototype = Document.prototype;
  const getDefaultView = Object.getOwnPropertyDescriptor(documentPrototype, "defaultView")!.get!;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ModelContext");
  if (
    !Object.isExtensible(documentPrototype) ||
    (constructorDescriptor && !constructorDescriptor.configurable) ||
    (!constructorDescriptor && !Object.isExtensible(globalThis))
  ) {
    throw new TypeError("Cannot install WebMCP on this realm");
  }

  Object.defineProperty(globalThis, "ModelContext", {
    value: modelContextConstructor,
    configurable: true,
    writable: true,
  });

  // A method is non-constructible; defaultView supplies the native Document brand check.
  const { getModelContext } = {
    getModelContext(this: Document): WebMCP.ModelContext {
      getDefaultView.call(this);
      let context = contexts.get(this);
      if (!context) {
        context = new ModelContextPolyfill(this);
        contexts.set(this, context);
      }
      return context;
    },
  };
  Object.defineProperty(getModelContext, "name", { value: "get modelContext" });
  Object.defineProperty(documentPrototype, "modelContext", {
    configurable: true,
    enumerable: true,
    get: getModelContext,
  });
}

class ModelContextPolyfill extends EventTarget implements WebMCP.ModelContext {
  readonly #document: Document;
  readonly #tools = new Map<string, StoredTool>();
  #toolchangeHandler: WebMCP.ModelContext["ontoolchange"] = null;
  readonly #toolchangeListener = (event: Event): void => {
    const handler = this.#toolchangeHandler;
    if (handler) {
      const result = Reflect.apply(handler, this, [event]);
      if (result === false) {
        Event.prototype.preventDefault.call(event);
      }
    }
  };

  constructor(owner: Document) {
    super();
    this.#document = owner;
  }

  get ontoolchange(): WebMCP.ModelContext["ontoolchange"] {
    return this.#toolchangeHandler;
  }

  set ontoolchange(handler: WebMCP.ModelContext["ontoolchange"]) {
    const nextHandler = typeof handler === "function" ? handler : null;
    // Replacing a handler preserves its listener position; clearing it removes that position.
    if (!this.#toolchangeHandler && nextHandler) {
      this.addEventListener("toolchange", this.#toolchangeListener);
    }
    if (this.#toolchangeHandler && !nextHandler) {
      this.removeEventListener("toolchange", this.#toolchangeListener);
    }
    this.#toolchangeHandler = nextHandler;
  }

  // Default parameters preserve Web IDL's required-argument counts in function.length.
  async registerTool(
    tool: object,
    options: WebMCP.ModelContextRegisterToolOptions = {},
  ): Promise<void> {
    const { name, title, description, annotations, inputSchema, execute } =
      readToolDefinition(tool);
    const settings = readDictionary(options);
    const exposedTo = readOriginSequence(settings.exposedTo);
    const registrationSignal = readAbortSignal(settings.signal);

    const ownerWindow = requireActiveWindow(this.#document);

    // Duplicate, then name, then description: the draft's order.
    if (this.#tools.has(name)) {
      throw new NativeDOMException(
        `A tool named ${name} is already registered`,
        "InvalidStateError",
      );
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) {
      throw new NativeDOMException(
        `Tool names are 1 to 128 characters of ASCII alphanumerics, "_", "-" or ".": ${name}`,
        "InvalidStateError",
      );
    }
    if (!description) {
      throw new NativeDOMException("A tool description cannot be empty", "InvalidStateError");
    }
    const serializedSchema = inputSchema === undefined ? undefined : serializeJSON(inputSchema);
    registrationSignal?.throwIfAborted();
    rejectUnsupportedOrigins(exposedTo);

    const storedTool: StoredTool = {
      metadata: {
        name,
        title,
        description,
        annotations,
        window: ownerWindow,
        origin: ownerWindow.origin,
      },
      serializedSchema,
      execute,
    };

    return new Promise<void>((resolve, reject) => {
      // Abort unregisters the tool and also rejects any pending registration.
      registrationSignal?.addEventListener(
        "abort",
        () => {
          this.#tools.delete(name);
          this.#queueToolChange();
          reject(registrationSignal.reason);
        },
        { once: true },
      );

      this.#tools.set(name, storedTool);
      this.#queueToolChange();
      queueTask(resolve);
    });
  }

  async getTools(
    options: WebMCP.ModelContextGetToolOptions = {},
  ): Promise<WebMCP.RegisteredTool[]> {
    const settings = readDictionary(options);
    const fromOrigins = readOriginSequence(settings.fromOrigins);

    requireActiveWindow(this.#document);
    rejectUnsupportedOrigins(fromOrigins);

    const tools = Array.from(this.#tools.values(), copyToolMetadata);

    // Compare code units; localeCompare() would change the draft's sort order.
    tools.sort((left, right) => {
      if (left.name === right.name) {
        return 0;
      }
      return left.name < right.name ? -1 : 1;
    });

    return new Promise((resolve) => {
      queueTask(() => resolve(tools));
    });
  }

  async executeTool(
    tool: WebMCP.RegisteredTool,
    inputObject: object | undefined = undefined,
    options: WebMCP.ModelContextExecuteToolOptions = {},
  ): Promise<string> {
    const target = readExecutionTarget(tool);
    const settings = readDictionary(options);
    const callerSignal = readAbortSignal(settings.signal);

    requireActiveWindow(this.#document);
    const expectedOrigin = URL.parse(target.origin)?.origin;
    if (!expectedOrigin || expectedOrigin === "null") {
      throw new NativeDOMException("Invalid or opaque origin", "NotSupportedError");
    }
    if (!isObject(inputObject)) {
      throw new TypeError("inputObject must be an object");
    }

    const serializedInput = serializeJSON(inputObject);
    callerSignal?.throwIfAborted();
    if (target.window !== this.#document.defaultView) {
      // Cross-document routing is unsupported; dispatch failures use UnknownError.
      throw new NativeDOMException("Tool execution failed", "UnknownError");
    }

    return new Promise<string>((resolve, reject) => {
      const callbackController = new AbortController();
      // Cancellation can arrive after the callback finishes but before its result is delivered;
      // the promise is already rejected then, so a late resolve is ignored.
      let callbackFinished = false;

      const onCallerAbort = (): void => {
        reject(callerSignal!.reason);

        // Reject the caller first; the running callback receives a default AbortError.
        queueTask(() => {
          if (!callbackFinished) {
            callbackController.abort();
          }
        });
      };

      const rejectExecution = (): void => {
        callbackFinished = true;
        queueTask(() => {
          callerSignal?.removeEventListener("abort", onCallerAbort);
          reject(new NativeDOMException("Tool execution failed", "UnknownError"));
        });
      };

      const completeExecution = (value: unknown): void => {
        callbackFinished = true;
        // A cancelled call must not run the author's toJSON during serialization.
        if (callerSignal?.aborted) {
          return;
        }

        try {
          const serializedResult = serializeJSON(value);
          queueTask(() => {
            callerSignal?.removeEventListener("abort", onCallerAbort);
            resolve(serializedResult);
          });
        } catch {
          rejectExecution();
        }
      };

      const dispatchTool = (): void => {
        if (callerSignal?.aborted) {
          return;
        }

        try {
          const ownerWindow = requireActiveWindow(this.#document);
          const storedTool = this.#tools.get(target.name);
          if (!storedTool || expectedOrigin !== ownerWindow.origin) {
            rejectExecution();
            return;
          }

          const input: unknown = JSON.parse(serializedInput);
          if (!isObject(input)) {
            rejectExecution();
            return;
          }

          // The callback runs without the registration object as its receiver.
          const execute = storedTool.execute;
          const callbackResult = execute(input, { signal: callbackController.signal });
          Promise.resolve(callbackResult).then(completeExecution, rejectExecution);
        } catch {
          rejectExecution();
        }
      };

      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      queueTask(dispatchTool);
    });
  }

  #queueToolChange(): void {
    queueTask(() => this.dispatchEvent(new Event("toolchange")));
  }
}

// Web IDL exposes a non-constructible interface with enumerable prototype members.
const modelContextConstructor = function ModelContext(): never {
  throw new TypeError("Illegal constructor");
};
// Preserve the public name through minification.
Object.defineProperty(modelContextConstructor, "name", { value: "ModelContext" });
Object.defineProperty(modelContextConstructor, "prototype", {
  value: ModelContextPolyfill.prototype,
  writable: false,
});
Object.setPrototypeOf(modelContextConstructor, EventTarget);
Object.defineProperties(ModelContextPolyfill.prototype, {
  constructor: { value: modelContextConstructor, configurable: true, writable: true },
  [Symbol.toStringTag]: { value: "ModelContext", configurable: true },
  registerTool: { enumerable: true },
  getTools: { enumerable: true },
  executeTool: { enumerable: true },
  ontoolchange: { enumerable: true },
});

// Web IDL reads and converts dictionary members in lexicographical order.
function readToolDefinition(value: unknown) {
  const descriptor = readDictionary(value);
  const annotations = readAnnotations(descriptor.annotations);
  const description = toDOMString(requireMember(descriptor.description, "description"));
  const callback = requireMember(descriptor.execute, "execute");
  if (typeof callback !== "function") {
    throw new TypeError("execute must be a function");
  }
  // SAFETY: callability is checked above; inputs and results are converted at invocation.
  const execute = callback as WebMCP.ToolExecuteCallback<object>;
  const inputSchema = readInputSchema(descriptor.inputSchema);
  const name = toDOMString(requireMember(descriptor.name, "name"));
  const rawTitle = descriptor.title;
  const title = rawTitle === undefined ? "" : toUSVString(rawTitle);

  return { name, title, description, annotations, inputSchema, execute };
}

// Convert the whole RegisteredTool dictionary, even members not used for dispatch.
function readExecutionTarget(value: unknown) {
  const descriptor = readDictionary(value);
  readAnnotations(descriptor.annotations);
  toDOMString(requireMember(descriptor.description, "description"));
  readInputSchema(descriptor.inputSchema);
  const name = toDOMString(requireMember(descriptor.name, "name"));
  const origin = toUSVString(requireMember(descriptor.origin, "origin"));
  const title = descriptor.title;
  if (title !== undefined) {
    toDOMString(title);
  }
  const targetWindow = requireMember(descriptor.window, "window");
  if (!isObject(targetWindow)) {
    throw new TypeError("window must be a Window");
  }
  // The native getter checks the Window brand across realms without changing identity.
  getWindow!.call(targetWindow);

  return { name, origin, window: targetWindow };
}

function readInputSchema(value: unknown): object | undefined {
  if (value !== undefined && !isObject(value)) {
    throw new TypeError("inputSchema must be an object");
  }
  return value;
}

function copyToolMetadata({ metadata, serializedSchema }: StoredTool): WebMCP.RegisteredTool {
  // SAFETY: the draft keeps whatever JSON toJSON produced; the cast matches RegisteredTool's type.
  const inputSchema =
    serializedSchema === undefined ? undefined : (JSON.parse(serializedSchema) as object);

  // Insert members in Web IDL order, then omit absent optional members.
  const tool: WebMCP.RegisteredTool = {
    annotations: metadata.annotations ? { ...metadata.annotations } : undefined,
    description: metadata.description,
    inputSchema,
    name: metadata.name,
    origin: metadata.origin,
    title: metadata.title,
    window: metadata.window,
  };

  if (tool.annotations === undefined) {
    delete tool.annotations;
  }
  if (tool.inputSchema === undefined) {
    delete tool.inputSchema;
  }
  return tool;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

// https://webidl.spec.whatwg.org/#es-dictionary
function readDictionary(value: unknown): Record<PropertyKey, unknown> {
  if (value == null) {
    return {};
  }
  if (!isObject(value)) {
    throw new TypeError("Expected a dictionary");
  }
  // SAFETY: the object check permits property reads; each member still needs conversion.
  return value as Record<PropertyKey, unknown>;
}

function readAnnotations(value: unknown): WebMCP.ToolAnnotations | undefined {
  if (value === undefined) {
    return undefined;
  }
  const annotations = readDictionary(value);
  return {
    consequentialHint: Boolean(annotations.consequentialHint),
    readOnlyHint: Boolean(annotations.readOnlyHint),
    untrustedContentHint: Boolean(annotations.untrustedContentHint),
  };
}

// https://webidl.spec.whatwg.org/#es-DOMString
function toDOMString(value: unknown): string {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol to a string");
  }
  return String(value);
}

// https://webidl.spec.whatwg.org/#es-USVString
function toUSVString(value: unknown): string {
  return toDOMString(value).toWellFormed();
}

function requireMember(value: unknown, name: string): unknown {
  if (value === undefined) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function serializeJSON(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new TypeError("Value is not JSON-serializable");
  }
  return result;
}

function readAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) {
    return undefined;
  }
  // SAFETY: any() validates the native brand across realms before we use the signal.
  // Composition also survives stopImmediatePropagation() on the original signal.
  return AbortSignal.any([value as AbortSignal]);
}

// https://webidl.spec.whatwg.org/#es-sequence
function readOriginSequence(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isObject(value)) {
    throw new TypeError("Origins must be a sequence");
  }
  const getIterator = readDictionary(value)[Symbol.iterator];
  if (typeof getIterator !== "function") {
    throw new TypeError("Origins must be a sequence");
  }
  // Use the cached method and original receiver without reading the method's own properties.
  const iterable = {
    [Symbol.iterator]() {
      return Reflect.apply(getIterator, value, []);
    },
  };
  return Array.from(iterable, toUSVString);
}

// Validate before refusing cross-document support, preserving SecurityError precedence.
// Scheme and host checks cannot recognize browser-specific trusted origins.
function rejectUnsupportedOrigins(origins: string[]): void {
  for (const origin of origins) {
    let url = URL.parse(origin);
    if (!url) {
      throw new NativeDOMException("Invalid origin", "SecurityError");
    }
    // blob: URLs inherit their origin's scheme and host.
    if (url.origin !== "null") {
      url = new URL(url.origin);
    }
    const isLoopback =
      url.hostname === "[::1]" ||
      // URL canonicalizes numeric hosts; exclude domains such as 127.example.test.
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "localhost." ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".localhost.");
    const isSecureScheme = ["https:", "wss:", "file:"].includes(url.protocol);
    const isLocalHttp = ["http:", "ws:"].includes(url.protocol) && (isLoopback || isLocalhost);

    if (!isSecureScheme && !isLocalHttp) {
      throw new NativeDOMException("Origin is not potentially trustworthy", "SecurityError");
    }
  }
  if (origins.length) {
    throw new NativeDOMException("Cross-document tools require native WebMCP", "NotSupportedError");
  }
}

function requireActiveWindow(owner: Document): Window {
  const view = owner.defaultView;
  if (!view || view.document !== owner || (view.frameElement && !view.frameElement.isConnected)) {
    throw new NativeDOMException("The document is not fully active", "InvalidStateError");
  }
  if (view.originAgentCluster === false && view.location.protocol !== "file:") {
    throw new NativeDOMException("An origin-keyed agent cluster is required", "SecurityError");
  }

  requireToolsPermission(owner, view);
  return view;
}

function requireToolsPermission(owner: Document, view: Window): void {
  // Query the policy only if the browser recognizes the tools feature.
  const policy =
    ("permissionsPolicy" in owner ? owner.permissionsPolicy : undefined) ??
    ("featurePolicy" in owner ? owner.featurePolicy : undefined);
  if (
    isObject(policy) &&
    "features" in policy &&
    "allowsFeature" in policy &&
    typeof policy.features === "function" &&
    typeof policy.allowsFeature === "function" &&
    policy.features().includes("tools")
  ) {
    if (!policy.allowsFeature("tools")) {
      throw new NativeDOMException("WebMCP is disabled by Permissions Policy", "NotAllowedError");
    }
    return;
  }
  // Same-origin access approximates the default policy; explicit allowlists need native support.
  try {
    void view.parent.document;
  } catch {
    throw new NativeDOMException(
      "Cross-origin frames require native Permissions Policy",
      "NotAllowedError",
    );
  }
}

// Timers approximate the WebMCP task source; navigation cleanup requires native support.
function queueTask(callback: () => void): void {
  setTimeout(callback, 0);
}
