const context = document.modelContext;
const countOutput = document.getElementById("count");
const registrationStatus = document.getElementById("status");
const executionResult = document.getElementById("result");
const amountInput = document.getElementById("amount");
if (
  !context ||
  !countOutput ||
  !registrationStatus ||
  !executionResult ||
  !(amountInput instanceof HTMLInputElement)
) {
  throw new Error("The counter fixture requires WebMCP and its form elements");
}

/** @type {AbortController | undefined} */
let registration;
let count = 0;

const register = async () => {
  if (registration && !registration.signal.aborted) {
    return;
  }
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
};

document.getElementById("register")?.addEventListener("click", register);
document.getElementById("unregister")?.addEventListener("click", () => {
  registration?.abort();
  registrationStatus.textContent = "unregistered";
});
document.getElementById("execute")?.addEventListener("click", async () => {
  try {
    const [tool] = await context.getTools();
    if (!tool) {
      throw new Error("The counter tool is not registered");
    }
    const amount = Number(amountInput.value);
    executionResult.textContent = await context.executeTool(tool, { amount });
  } catch (error) {
    executionResult.textContent = error instanceof Error ? error.name : String(error);
  }
});

await register();
