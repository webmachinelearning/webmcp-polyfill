import "../dist/auto.js";

if (document.modelContext) {
  const context: WebMCP.ModelContext = document.modelContext;
  context.registerTool({
    name: "greet",
    description: "Greet someone",
    annotations: { debugging: true },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        profile: {
          type: "object",
          properties: { age: { type: "number" }, nickname: { type: "string" } },
          required: ["age"],
        },
      },
      required: ["name", "profile"],
    },
    execute(input, { signal }) {
      const name: string = input.name;
      const age: number = input.profile.age;
      const nickname: string | undefined = input.profile.nickname;
      const aborted: boolean = signal.aborted;
      // @ts-expect-error The schema infers name as a string.
      const invalid: number = input.name;
      // @ts-expect-error An optional schema property is not always present.
      const requiredNickname: string = input.profile.nickname;
      return { name, age, nickname, aborted, invalid, requiredNickname };
    },
  });

  const [tool] = await context.getTools();
  if (!tool) {
    throw new Error("The registered tool was not discovered");
  }
  const debugging: boolean | undefined = tool.annotations?.debugging;
  void debugging;
  const result: string = await context.executeTool(
    tool,
    {},
    { signal: new AbortController().signal },
  );
  void result;
  const omitted: string = await context.executeTool(tool);
  const explicitUndefined: string = await context.executeTool(tool, undefined, {
    signal: new AbortController().signal,
  });
  void omitted;
  void explicitUndefined;

  // @ts-expect-error The current draft accepts objects, not serialized JSON.
  context.executeTool(tool, "{}");
}
