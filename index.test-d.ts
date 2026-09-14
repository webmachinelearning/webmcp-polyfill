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
  const [tool] = await context.getTools();
  const result: string = await context.executeTool(
    tool,
    {},
    { signal: new AbortController().signal },
  );
  // @ts-expect-error The current draft accepts objects, not serialized JSON.
  context.executeTool(tool, "{}");
  void result;
}
