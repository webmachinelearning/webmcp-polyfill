const context = document.modelContext;
const element = (id) => document.getElementById(id);
let registration;
let count = 0;
async function register() {
  registration = new AbortController();
  await context.registerTool(
    {
      name: "increment",
      description: "Increment the visible counter",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
      execute({ amount }) {
        if (!Number.isFinite(amount) || amount < 0)
          throw new TypeError("Expected a nonnegative amount");
        count += amount;
        element("count").textContent = String(count);
        return { count };
      },
    },
    { signal: registration.signal },
  );
  element("status").textContent = "registered";
}
element("register").onclick = register;
element("unregister").onclick = async () => {
  registration.abort();
  await context.getTools();
  element("status").textContent = "unregistered";
};
element("execute").onclick = async () => {
  try {
    const [tool] = await context.getTools();
    element("result").textContent = await context.executeTool(tool, {
      amount: Number(element("amount").value),
    });
  } catch (error) {
    element("result").textContent = error.name;
  }
};
await register();
