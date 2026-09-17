const context = document.modelContext;
const countOutput = document.getElementById("count");
const registrationStatus = document.getElementById("status");
const executionResult = document.getElementById("result");
const amountInput = document.getElementById("amount");
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
        if (!Number.isFinite(amount) || amount < 0) {
          throw new TypeError("Expected a nonnegative amount");
        }
        count += amount;
        countOutput.textContent = String(count);
        return { count };
      },
    },
    { signal: registration.signal },
  );
  registrationStatus.textContent = "registered";
}

document.getElementById("register").onclick = register;
document.getElementById("unregister").onclick = () => {
  registration.abort();
  registrationStatus.textContent = "unregistered";
};
document.getElementById("execute").onclick = async () => {
  try {
    const [tool] = await context.getTools();
    const amount = Number(amountInput.value);
    executionResult.textContent = await context.executeTool(tool, { amount });
  } catch (error) {
    executionResult.textContent = error.name;
  }
};

await register();
