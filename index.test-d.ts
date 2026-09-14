import "./dist/auto.js";

if (document.modelContext) {
  const context: WebMCP.ModelContext = document.modelContext;
  context.registerTool({
    name: "greet",
    description: "Greet someone",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    execute(input, { signal }) {
      const name: string = input.name;
      const aborted: boolean = signal.aborted;
      // @ts-expect-error Upstream inference keeps name a string.
      const invalid: number = input.name;
      return { name, aborted, invalid };
    },
  });
  const tools: WebMCP.RegisteredTool[] = await context.getTools();
  // @ts-expect-error Execution is deferred to a separate change.
  void context.executeTool;
  void tools;
}
