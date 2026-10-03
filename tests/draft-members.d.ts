// SubmitEvent members come from the declarative explainer and have no upstream types yet.
export {};

declare global {
  interface SubmitEvent {
    readonly agentInvoked: boolean;
    respondWith(agentResponse: PromiseLike<unknown>): void;
  }
}
