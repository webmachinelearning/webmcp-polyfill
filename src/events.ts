/*!
 * Copyright (c) 2026 WebMCP polyfill contributors
 * SPDX-License-Identifier: MIT
 */

import type { WebMCP } from "webmcp-types";

/**
 * Dispatched at a `ModelContext` when the execution of a tool begins.
 *
 * @see https://webmachinelearning.github.io/webmcp/#tool-activated-event
 */
export class ToolActivatedEvent extends Event implements WebMCP.ToolActivatedEvent {
  readonly #toolName: string;

  // A defaulted second parameter keeps Web IDL's required-argument count in function.length.
  constructor(type: string, eventInitDict: WebMCP.ToolActivatedEventInit = {}) {
    requireEventType(arguments.length);
    // Event converts type, then bubbles, cancelable and composed; toolName sorts after them.
    super(type, eventInitDict);
    this.#toolName = readToolName(eventInitDict);
  }

  get toolName(): string {
    return this.#toolName;
  }
}

/**
 * Dispatched at a `ModelContext` when the execution of a tool is cancelled.
 *
 * @see https://webmachinelearning.github.io/webmcp/#tool-cancel-event
 */
export class ToolCancelEvent extends Event implements WebMCP.ToolCancelEvent {
  readonly #toolName: string;

  constructor(type: string, eventInitDict: WebMCP.ToolCancelEventInit = {}) {
    requireEventType(arguments.length);
    super(type, eventInitDict);
    this.#toolName = readToolName(eventInitDict);
  }

  get toolName(): string {
    return this.#toolName;
  }
}

// Web IDL interface objects keep their names through minification and expose enumerable
// attributes and a class string on the prototype.
for (const [eventInterface, name] of [
  [ToolActivatedEvent, "ToolActivatedEvent"],
  [ToolCancelEvent, "ToolCancelEvent"],
] as const) {
  Object.defineProperty(eventInterface, "name", { value: name });
  Object.defineProperties(eventInterface.prototype, {
    toolName: { enumerable: true },
    [Symbol.toStringTag]: { value: name, configurable: true },
  });
}

// An explicit undefined type is converted to "undefined"; only a missing one throws.
function requireEventType(argumentCount: number): void {
  if (argumentCount < 1) {
    throw new TypeError("1 argument required, but only 0 present");
  }
}

// Event has already rejected an eventInitDict that is neither an object nor nullish.
function readToolName(eventInitDict: unknown): string {
  if (eventInitDict == null) {
    return "";
  }
  // SAFETY: Event's dictionary conversion above proved this is an object.
  const toolName = (eventInitDict as Record<PropertyKey, unknown>).toolName;
  if (toolName === undefined) {
    return "";
  }
  // https://webidl.spec.whatwg.org/#es-DOMString
  if (typeof toolName === "symbol") {
    throw new TypeError("Cannot convert a Symbol to a string");
  }
  return String(toolName);
}
