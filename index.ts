import type { WebMCP } from "webmcp-types";
export type { WebMCP } from "webmcp-types";

/*!
 * Copyright (c) 2026 WebMCP polyfill contributors
 * SPDX-License-Identifier: MIT
 */

// Detached windows may stop exposing these bindings.
const NativeDOMException = globalThis.DOMException;
const windowGetter = Object.getOwnPropertyDescriptor(globalThis, "window")?.get;

interface Tool {
  metadata: Omit<WebMCP.RegisteredTool, "inputSchema">;
  // Snapshot at registration; parse a fresh copy for each discovery result.
  schema?: string;
  execute: WebMCP.ToolExecuteCallback<object>;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

// https://webidl.spec.whatwg.org/#es-dictionary
function dictionary(value: unknown): Record<PropertyKey, unknown> {
  if (value == null) return {};
  if (!isObject(value)) throw new TypeError("Expected a dictionary");
  // Dictionary members remain unknown until converted.
  return value as Record<PropertyKey, unknown>;
}

function toolAnnotations(value: unknown): WebMCP.ToolAnnotations | undefined {
  if (value === undefined) return undefined;
  const annotations = dictionary(value);
  return {
    consequentialHint: Boolean(annotations.consequentialHint),
    readOnlyHint: Boolean(annotations.readOnlyHint),
    untrustedContentHint: Boolean(annotations.untrustedContentHint),
  };
}

// https://webidl.spec.whatwg.org/#es-DOMString
function domString(value: unknown): string {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol to a string");
  return String(value);
}

function required(value: unknown, name: string): unknown {
  if (value === undefined) throw new TypeError(`${name} is required`);
  return value;
}

function serialize(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Value is not JSON-serializable");
  return result;
}

function signalOption(value: unknown): AbortSignal | undefined {
  // Native brand check across realms; composition survives stopImmediatePropagation().
  return value === undefined ? undefined : AbortSignal.any([value as AbortSignal]);
}

// https://webidl.spec.whatwg.org/#es-sequence
function originSequence(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isObject(value)) throw new TypeError("Origins must be a sequence");
  const iterator: unknown = Reflect.get(value, Symbol.iterator);
  if (typeof iterator !== "function") throw new TypeError("Origins must be a sequence");
  // Web IDL gets the iterator method once and calls it with the original receiver.
  return Array.from({ [Symbol.iterator]: () => Reflect.apply(iterator, value, []) }, (origin) =>
    domString(origin).toWellFormed(),
  );
}

// Validate before refusing cross-document support, preserving SecurityError precedence.
// ponytail: scheme/host approximation; use native origin checks for full conformance.
function rejectUnsupportedOrigins(origins: string[]): void {
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
      // blob: URLs inherit their origin's scheme and host.
      if (url.origin !== "null") url = new URL(url.origin);
    } catch {
      throw new NativeDOMException("Invalid origin", "SecurityError");
    }
    const local =
      url.hostname === "[::1]" ||
      // URL canonicalizes numeric hosts; exclude domains such as 127.example.test.
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
      url.hostname === "localhost" ||
      url.hostname === "localhost." ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".localhost.");
    if (
      !["https:", "wss:", "file:"].includes(url.protocol) &&
      !(["http:", "ws:"].includes(url.protocol) && local)
    ) {
      throw new NativeDOMException("Origin is not potentially trustworthy", "SecurityError");
    }
  }
  if (origins.length) {
    throw new NativeDOMException("Cross-document tools require native WebMCP", "NotSupportedError");
  }
}

function activeView(owner: Document): Window {
  const view = owner.defaultView;
  if (!view || view.document !== owner || (view.frameElement && !view.frameElement.isConnected)) {
    throw new NativeDOMException("The document is not fully active", "InvalidStateError");
  }
  if (view.originAgentCluster === false && view.location.protocol !== "file:") {
    throw new NativeDOMException("An origin-keyed agent cluster is required", "SecurityError");
  }
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
    if (policy.allowsFeature("tools")) return view;
    throw new NativeDOMException("WebMCP is disabled by Permissions Policy", "NotAllowedError");
  }
  // ponytail: same-origin fallback; native policy support is needed to honor allowlists.
  try {
    void view.parent.document;
  } catch {
    throw new NativeDOMException(
      "Cross-origin frames require native Permissions Policy",
      "NotAllowedError",
    );
  }
  return view;
}

// ponytail: timer tasks; exact WebMCP scheduling and navigation cleanup need native support.
function queueTask(callback: () => void): void {
  setTimeout(callback, 0);
}

// Default parameters preserve Web IDL's required-argument counts in function.length.
class ModelContextPolyfill extends EventTarget implements WebMCP.ModelContext {
  readonly #owner: Document;
  readonly #tools = new Map<string, Tool>();
  #handler: WebMCP.ModelContext["ontoolchange"] = null;
  readonly #listener = (event: Event): void => {
    this.#handler?.call(this, event);
  };

  constructor(owner: Document) {
    super();
    this.#owner = owner;
  }

  get ontoolchange(): WebMCP.ModelContext["ontoolchange"] {
    return this.#handler;
  }

  set ontoolchange(handler: WebMCP.ModelContext["ontoolchange"]) {
    const next = typeof handler === "function" ? handler : null;
    // Replacing a handler preserves its listener position; clearing it removes that position.
    if (!this.#handler && next) this.addEventListener("toolchange", this.#listener);
    if (this.#handler && !next) this.removeEventListener("toolchange", this.#listener);
    this.#handler = next;
  }

  async registerTool(
    tool: object,
    options: WebMCP.ModelContextRegisterToolOptions = {},
  ): Promise<void> {
    const descriptor = dictionary(tool);
    const annotations = toolAnnotations(descriptor.annotations);
    const description = domString(required(descriptor.description, "description"));
    const callback = required(descriptor.execute, "execute");
    if (typeof callback !== "function") throw new TypeError("execute must be a function");
    // Callability is checked here; inputs and results are converted at invocation.
    const execute = callback as WebMCP.ToolExecuteCallback<object>;
    const inputSchema = descriptor.inputSchema;
    if (inputSchema !== undefined && !isObject(inputSchema))
      throw new TypeError("inputSchema must be an object");
    const name = domString(required(descriptor.name, "name"));
    const rawTitle = descriptor.title;
    const title = rawTitle === undefined ? "" : domString(rawTitle).toWellFormed();
    const settings = dictionary(options);
    const exposedTo = originSequence(settings.exposedTo);
    const signal = signalOption(settings.signal);

    const view = activeView(this.#owner);
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
    const schema = inputSchema === undefined ? undefined : serialize(inputSchema);
    signal?.throwIfAborted();
    rejectUnsupportedOrigins(exposedTo);

    const entry: Tool = {
      metadata: { name, title, description, window: view, origin: view.origin },
      schema,
      execute,
    };
    if (annotations !== undefined) entry.metadata.annotations = annotations;
    return new Promise<void>((resolve, reject) => {
      // Abort unregisters the tool and also rejects any pending registration.
      signal?.addEventListener(
        "abort",
        () => {
          this.#tools.delete(name);
          queueTask(() => this.dispatchEvent(new Event("toolchange")));
          reject(signal.reason);
        },
        { once: true },
      );
      this.#tools.set(name, entry);
      queueTask(() => this.dispatchEvent(new Event("toolchange")));
      queueTask(resolve);
    });
  }

  async getTools(
    options: WebMCP.ModelContextGetToolOptions = {},
  ): Promise<WebMCP.RegisteredTool[]> {
    const fromOrigins = originSequence(dictionary(options).fromOrigins);
    activeView(this.#owner);
    rejectUnsupportedOrigins(fromOrigins);
    const tools = [...this.#tools.values()]
      // Web IDL creates a dictionary's members in lexicographical order.
      .map(
        ({ metadata, schema }): WebMCP.RegisteredTool => ({
          ...(metadata.annotations && { annotations: { ...metadata.annotations } }),
          description: metadata.description,
          ...(schema !== undefined && { inputSchema: JSON.parse(schema) as object }),
          name: metadata.name,
          origin: metadata.origin,
          title: metadata.title,
          window: metadata.window,
        }),
      )
      // Code-unit order, not locale order.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return new Promise((resolve) => queueTask(() => resolve(tools)));
  }

  async executeTool(
    tool: WebMCP.RegisteredTool,
    inputObject: object | undefined = undefined,
    options: WebMCP.ModelContextExecuteToolOptions = {},
  ): Promise<string> {
    // Web IDL conversion reads every member in order, including fields unused by execution.
    const descriptor = dictionary(tool);
    toolAnnotations(descriptor.annotations);
    domString(required(descriptor.description, "description"));
    const inputSchema = descriptor.inputSchema;
    if (inputSchema !== undefined && !isObject(inputSchema))
      throw new TypeError("inputSchema must be an object");
    const name = domString(required(descriptor.name, "name"));
    const origin = domString(required(descriptor.origin, "origin")).toWellFormed();
    const title = descriptor.title;
    if (title !== undefined) domString(title);
    const target = required(descriptor.window, "window");
    if (!isObject(target)) throw new TypeError("window must be a Window");
    // The native getter checks the Window brand across realms.
    windowGetter!.call(target);
    const signal = signalOption(dictionary(options).signal);
    activeView(this.#owner);
    let expectedOrigin = "null";
    try {
      expectedOrigin = new URL(origin).origin;
    } catch {
      // An unparseable origin falls through to the opaque check below.
    }
    if (expectedOrigin === "null") {
      throw new NativeDOMException("Invalid or opaque origin", "NotSupportedError");
    }
    if (!isObject(inputObject)) throw new TypeError("inputObject must be an object");
    const input = serialize(inputObject);
    signal?.throwIfAborted();
    if (target !== this.#owner.defaultView) {
      // Cross-document routing is unsupported; dispatch failures use UnknownError.
      throw new NativeDOMException("Tool execution failed", "UnknownError");
    }

    return new Promise<string>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let callbackSettled = false;
      const claimSettlement = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        return true;
      };
      const abort = (): void => {
        if (!claimSettlement()) return;
        reject(signal!.reason);
        // Reject the caller first; the running callback receives a default AbortError.
        queueTask(() => {
          if (!callbackSettled) controller.abort();
        });
      };
      const fail = (): void => {
        callbackSettled = true;
        queueTask(() => {
          if (claimSettlement())
            reject(new NativeDOMException("Tool execution failed", "UnknownError"));
        });
      };
      const complete = (value: unknown): void => {
        callbackSettled = true;
        // Checked before serializing: a cancelled call must not run the author's toJSON.
        if (settled) return;
        try {
          const result = serialize(value);
          queueTask(() => {
            if (claimSettlement()) resolve(result);
          });
        } catch {
          fail();
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      queueTask(() => {
        if (settled) return;
        try {
          // Dispatch and callback failures share the draft's UnknownError.
          const view = activeView(this.#owner);
          const entry = this.#tools.get(name);
          if (!entry || expectedOrigin !== view.origin) throw new Error();
          const args: unknown = JSON.parse(input);
          if (!isObject(args)) throw new Error();
          const { execute } = entry;
          Promise.resolve(execute(args, { signal: controller.signal })).then(complete, fail);
        } catch {
          fail();
        }
      });
    });
  }
}

const contexts = new WeakMap<Document, ModelContextPolyfill>();

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

/**
 * Install WebMCP in this secure document's realm, preserving any existing implementation.
 * Safe to call repeatedly or outside a browser. Each frame installs separately.
 *
 * @throws {TypeError} when the realm cannot be extended, rather than installing halfway.
 */
export function installWebMCP(): void {
  if (typeof document === "undefined" || !globalThis.isSecureContext || "modelContext" in document)
    return;
  const prototype = Document.prototype;
  const defaultViewGetter = Object.getOwnPropertyDescriptor(prototype, "defaultView")!.get!;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ModelContext");
  if (
    !Object.isExtensible(prototype) ||
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
      defaultViewGetter.call(this);
      let context = contexts.get(this);
      if (!context) {
        context = new ModelContextPolyfill(this);
        contexts.set(this, context);
      }
      return context;
    },
  };
  Object.defineProperty(getModelContext, "name", { value: "get modelContext" });
  Object.defineProperty(prototype, "modelContext", {
    configurable: true,
    enumerable: true,
    get: getModelContext,
  });
}
