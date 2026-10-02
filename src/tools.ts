import type { WebMCP } from "webmcp-types";

/** Tool metadata as its owner stores it and as frames exchange it. */
export interface ToolMetadata
  extends Pick<WebMCP.RegisteredTool, "name" | "title" | "description"> {
  annotations: WebMCP.ToolAnnotations | undefined;
  // Snapshot at registration; each discovery result parses a fresh copy.
  serializedSchema: string | undefined;
}

/** A tool as its owner stores it, whether registered by script or declared by a form. */
export interface StoredTool {
  metadata: ToolMetadata;
  // Origins other than the owner's that may discover and execute the tool.
  exposedTo: string[];
  // The draft's execute steps. run() calls activate(), which fires toolactivated, before it
  // returns; if run() throws first, the call fails without the event.
  run(input: object, signal: AbortSignal, activate: () => void): unknown;
  // Converts the value run() returns, or its promise fulfills with, into the result.
  serialize(result: unknown): string | null;
}

export const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/u;

// Detached windows may stop exposing this binding.
export const NativeDOMException = globalThis.DOMException;

export function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function executionError(): DOMException {
  return new NativeDOMException("Tool execution failed", "UnknownError");
}

// Installation replaces a page's configurable property, but must not fail halfway through.
export function canDefine(target: object, name: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return descriptor ? descriptor.configurable === true : Object.isExtensible(target);
}

// Message tasks approximate the WebMCP task source. Chained zero-delay timers are clamped to
// 4 ms, and one port keeps the tasks in order. Created on first use so an import stays inert.
let taskPort: MessagePort | undefined;
const queuedTasks: (() => void)[] = [];

export function queueTask(callback: () => void): void {
  if (!taskPort) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => queuedTasks.shift()?.();
    taskPort = channel.port2;
  }
  queuedTasks.push(callback);
  taskPort.postMessage(undefined);
}
