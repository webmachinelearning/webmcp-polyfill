import { test, expect } from "@playwright/test";
import { chromiumSchemas } from "./fixtures/schemas.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
  await page.addScriptTag({ url: "/auto.js" });
});

test("a form with a tool name and description becomes a discoverable tool", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const changed = new Promise((resolve) => {
      context.addEventListener("toolchange", resolve, { once: true });
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<form toolname="search_tool" tooldescription="Search the web">
        <input type="text" name="query" required toolparamdescription="The search query">
        <input type="number" name="limit" toolparamdescription="Max results count">
        <input type="checkbox" name="safe_search"
          toolparamdescription="Enable safe search filtering">
      </form>`,
    );
    await changed;
    const tools = await context.getTools();
    return tools.map(({ window: owner, ...tool }) => ({ ...tool, ownWindow: owner === window }));
  });

  expect(outcome).toEqual([
    {
      name: "search_tool",
      title: "",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          limit: { type: "number", multipleOf: 1, description: "Max results count" },
          safe_search: { type: "boolean", description: "Enable safe search filtering" },
        },
        required: ["query"],
      },
      origin: "http://localhost:8793",
      ownWindow: true,
    },
  ]);
});

test("form schemas match Chromium's for every supported control", async ({ page }) => {
  const schemas = await page.evaluate(async (cases) => {
    const context = document.modelContext!;
    const results: Record<string, string | undefined> = {};
    for (const { name, html } of cases) {
      document.body.innerHTML = html;
      const [tool] = await context.getTools();
      results[name] = JSON.stringify(tool?.inputSchema, null, 2);
    }
    return results;
  }, chromiumSchemas);

  // Chromium's tests and WPT's schema helper compare serialized JSON, so key order matters.
  expect(schemas).toEqual(
    Object.fromEntries(
      chromiumSchemas.map(({ name, schema }) => [name, JSON.stringify(schema, null, 2)]),
    ),
  );
});

test("a form's tool follows its definition, with one toolchange per change", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    let changes = 0;
    context.addEventListener("toolchange", () => changes++);
    const form = document.createElement("form");
    form.setAttribute("toolname", "my_tool");
    form.setAttribute("tooltitle", "My Title");
    form.setAttribute("tooldescription", "desc");
    const queryLabel = document.createElement("label");
    queryLabel.htmlFor = "query";
    queryLabel.textContent = "Query";
    const input = document.createElement("input");
    input.id = "query";
    input.name = "query";
    form.append(queryLabel, input);

    const steps: [string, () => void][] = [
      ["insert", () => document.body.append(form)],
      ["title", () => form.setAttribute("tooltitle", "New Title")],
      ["description", () => form.setAttribute("tooldescription", "")],
      ["name", () => form.setAttribute("toolname", "new_name")],
      ["no title", () => form.removeAttribute("tooltitle")],
      ["autosubmit", () => form.setAttribute("toolautosubmit", "")],
      ["unrelated attribute", () => input.setAttribute("data-unrelated", "value")],
      ["same control again", () => form.append(input)],
      ["same value", () => form.setAttribute("toolname", "new_name")],
      ["control type", () => (input.type = "number")],
      ["label text", () => ((queryLabel.firstChild as Text).data = "Search query")],
      ["no description", () => form.removeAttribute("tooldescription")],
      [
        "invalid name",
        () => {
          form.setAttribute("tooldescription", "desc");
          form.setAttribute("toolname", "not valid");
        },
      ],
    ];
    const results = [];
    for (const [label, mutate] of steps) {
      const before = changes;
      mutate();
      // Discovery resolves after any toolchange that the mutation queued.
      const tools = await context.getTools();
      results.push({
        label,
        changes: changes - before,
        tools: tools.map(({ name, title, description }) => ({ name, title, description })),
      });
    }
    return results;
  });

  const tool = (name: string, title: string, description: string) => [{ name, title, description }];
  expect(outcome).toEqual([
    { label: "insert", changes: 1, tools: tool("my_tool", "My Title", "desc") },
    { label: "title", changes: 1, tools: tool("my_tool", "New Title", "desc") },
    { label: "description", changes: 1, tools: tool("my_tool", "New Title", "") },
    { label: "name", changes: 1, tools: tool("new_name", "New Title", "") },
    { label: "no title", changes: 1, tools: tool("new_name", "", "") },
    { label: "autosubmit", changes: 1, tools: tool("new_name", "", "") },
    { label: "unrelated attribute", changes: 0, tools: tool("new_name", "", "") },
    { label: "same control again", changes: 0, tools: tool("new_name", "", "") },
    { label: "same value", changes: 0, tools: tool("new_name", "", "") },
    { label: "control type", changes: 1, tools: tool("new_name", "", "") },
    { label: "label text", changes: 1, tools: tool("new_name", "", "") },
    { label: "no description", changes: 1, tools: [] },
    { label: "invalid name", changes: 0, tools: [] },
  ]);
});

test("the first form or script tool to claim a name holds it until it is removed", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    let changes = 0;
    context.addEventListener("toolchange", () => changes++);
    const describe = async () =>
      (await context.getTools()).map((tool) => `${tool.name}: ${tool.description}`);
    const script = { name: "shared", description: "script", execute() {} };

    document.body.innerHTML = `
      <form toolname="shared" tooldescription="first"></form>
      <form toolname="shared" tooldescription="second"></form>`;
    const claimed = { tools: await describe(), changes };
    const held = await context.registerTool(script).catch((error) => error.name);

    // Chromium would register this form only once it changes.
    document.forms[0]!.remove();
    const promoted = await describe();

    // Script can reuse the name right after a removal, before mutation observers run.
    document.forms[0]!.remove();
    const registration = new AbortController();
    const reused = await context
      .registerTool(script, { signal: registration.signal })
      .then(() => "registered");

    document.body.innerHTML = `<form toolname="shared" tooldescription="waiting"></form>`;
    const blocked = await describe();
    registration.abort();
    const released = await describe();

    // Until mutation observers run, a renamed form keeps its name, even if the new one is invalid.
    document.forms[0]!.setAttribute("toolname", "not valid");
    const renamed = await context.registerTool(script).catch((error) => error.name);

    // A form that changes keeps its name, even after a form before it claims the same name.
    document.body.innerHTML = `<form toolname="shared" tooldescription="holder"></form>`;
    await describe();
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<form toolname="shared" tooldescription="earlier"></form>`,
    );
    await describe();
    document.forms[1]!.insertAdjacentHTML("beforeend", `<input name="added">`);
    const kept = await describe();
    return { claimed, held, promoted, reused, blocked, released, renamed, kept };
  });

  expect(outcome).toEqual({
    claimed: { tools: ["shared: first"], changes: 1 },
    held: "InvalidStateError",
    promoted: ["shared: second"],
    reused: "registered",
    blocked: ["shared: script"],
    released: ["shared: waiting"],
    renamed: "InvalidStateError",
    kept: ["shared: holder"],
  });
});

test("forms in the page register at installation, but not forms of other documents", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.body.innerHTML = `<form toolname="early" tooldescription="Parsed first"></form>`;
  });
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const installed = (await context.getTools()).map((tool) => tool.name);
    const markup = `<form toolname="detached" tooldescription="Elsewhere"></form>`;
    document.implementation.createHTMLDocument().body.innerHTML = markup;
    new DOMParser().parseFromString(markup, "text/html");
    const template = document.createElement("template");
    template.innerHTML = markup;
    document.body.append(template);
    const afterOtherDocuments = (await context.getTools()).map((tool) => tool.name);
    return { installed, afterOtherDocuments };
  });

  expect(outcome).toEqual({ installed: ["early"], afterOtherDocuments: ["early"] });
});

test("a form adopted by another document unregisters", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <iframe></iframe><form toolname="moved" tooldescription="Moved"></form>`;
    const before = (await context.getTools()).map((tool) => tool.name);
    const frame = document.querySelector("iframe")!;
    frame.contentDocument!.body.append(document.forms[0]!);
    const after = (await context.getTools()).map((tool) => tool.name);
    return { before, after };
  });

  expect(outcome).toEqual({ before: ["moved"], after: [] });
});

test("controls named like form members do not shadow them", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="shadowed" tooldescription="Shadowed" toolautosubmit>
        <input name="elements"><input name="getAttribute"><input name="requestSubmit">
        <input name="contains"><input type="radio" name="scope" value="a">
        <input type="radio" name="scope" value="b"><button name="submit">Go</button>
      </form>
      <form toolname="after" tooldescription="After"></form>`;
    const tools = await context.getTools();
    const shadowed = tools.find((tool) => tool.name === "shadowed")!;
    document.forms[0]!.addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve("submitted"));
    });
    return {
      names: tools.map((tool) => tool.name),
      properties: Object.keys((shadowed.inputSchema as { properties: object }).properties),
      result: await context.executeTool(shadowed, { elements: "1" }).catch((error) => error.name),
    };
  });

  expect(outcome).toEqual({
    names: ["after", "shadowed"],
    properties: ["elements", "getAttribute", "requestSubmit", "contains", "scope"],
    result: "submitted",
  });
});

test("executing an autosubmit form fills it, then submits for the page's response", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="search" tooldescription="Search" toolautosubmit>
        <input name="query">
        <button>Search</button>
      </form>`;
    const form = document.forms[0]!;
    const input = form.elements[0] as HTMLInputElement;
    const order: string[] = [];
    for (const type of ["input", "change"]) {
      input.addEventListener(type, () => order.push(`${type} ${input.value}`));
    }
    context.addEventListener("toolactivated", () => order.push(`toolactivated ${input.value}`));
    form.addEventListener("submit", (event) => {
      order.push(`submit ${event.agentInvoked}`);
      event.preventDefault();
      event.respondWith(Promise.resolve("found it"));
    });

    const [tool] = await context.getTools();
    const result = await context.executeTool(tool!, { query: "testing" });
    return { result, order };
  });

  expect(outcome).toEqual({
    result: "found it",
    order: ["input testing", "change testing", "toolactivated testing", "submit true"],
  });
});

test("filling converts values and fires input and change events like Chromium", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="fill" tooldescription="Fill" toolautosubmit>
        <input name="text">
        <input name="count" type="number" step="any">
        <input name="agree" type="checkbox">
        <input name="size" type="radio" value="s"><input name="size" type="radio" value="m">
        <input name="tags" type="checkbox" value="a"><input name="tags" type="checkbox" value="b">
        <select name="pick"><option value="1">One</option><option value="2">Two</option></select>
        <select name="fruits" multiple>
          <option>apple</option><option>orange</option><option>banana</option>
        </select>
        <input name="token" type="hidden" toolparamdescription="Token">
      </form>`;
    const form = document.forms[0]!;
    const events: string[] = [];
    for (const type of ["input", "change"]) {
      form.addEventListener(type, (event) => {
        const control = event.target as HTMLInputElement;
        const value = ["radio", "checkbox"].includes(control.type) ? `=${control.value}` : "";
        events.push(`${type} ${control.name}${value}`);
      });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve("done"));
    });
    const [tool] = await context.getTools();
    const entries = () => Array.from(new FormData(form), ([name, value]) => `${name}=${value}`);

    const input = {
      text: 123,
      count: "456",
      agree: 1,
      size: "m",
      tags: ["a"],
      pick: 2,
      fruits: ["apple", "banana"],
      token: "secret",
    };
    await context.executeTool(tool!, input);
    const first = { entries: entries(), events: events.splice(0) };
    await context.executeTool(tool!, input);
    const repeated = events.splice(0);
    await context.executeTool(tool!, { agree: "false", tags: ["b"] });
    const changed = { entries: entries(), events: events.splice(0) };
    // Chromium formats a non-integer with six significant digits, filling 1.23457.
    await context.executeTool(tool!, { count: 1.2345678, agree: "TRUE" });
    const converted = entries();
    return { first, repeated, changed, converted };
  });

  expect(outcome.first).toEqual({
    entries: [
      "text=123",
      "count=456",
      "agree=on",
      "size=m",
      "tags=a",
      "pick=2",
      "fruits=apple",
      "fruits=banana",
      "token=secret",
    ],
    events: [
      "input text",
      "change text",
      "input count",
      "change count",
      "input agree=on",
      "change agree=on",
      "input size=m",
      "change size=m",
      "input tags=a",
      "change tags=a",
      "change tags=b",
      "input pick",
      "change pick",
      "input fruits",
      "change fruits",
    ],
  });
  // Unchanged values fire nothing, except that a checkbox or radio always fires change.
  expect(outcome.repeated).toEqual([
    "change agree=on",
    "change size=m",
    "change tags=a",
    "change tags=b",
  ]);
  expect(outcome.changed).toEqual({
    entries: [
      "text=123",
      "count=456",
      "size=m",
      "tags=b",
      "pick=2",
      "fruits=apple",
      "fruits=banana",
      "token=secret",
    ],
    events: [
      "input agree=on",
      "change agree=on",
      "input tags=a",
      "change tags=a",
      "input tags=b",
      "change tags=b",
    ],
  });
  expect(outcome.converted).toEqual([
    "text=123",
    "count=1.2345678",
    "agree=on",
    "size=m",
    "tags=b",
    "pick=2",
    "fruits=apple",
    "fruits=banana",
    "token=secret",
  ]);
});

const invalidInputs = {
  unknownParameter: { text: "changed", unknown: "value" },
  unknownOption: { text: "changed", pick: "c" },
  wordForCheckbox: { text: "changed", agree: "yes" },
  fractionForCheckbox: { text: "changed", agree: 0.5 },
  emptyNumber: { text: "changed", count: "" },
  wordForNumber: { text: "changed", count: "many" },
  stringForMultiple: { text: "changed", many: "x" },
  repeatedChoice: { text: "changed", many: ["x", "x"] },
  unknownCheckbox: { text: "changed", tags: ["c"] },
  stringForCheckboxes: { text: "changed", tags: "a" },
  wordForDate: { text: "changed", day: "tomorrow" },
  nullText: { text: null },
  arrayText: { text: ["changed"] },
};

test("invalid input rejects before any control changes or the tool activates", async ({
  page,
}) => {
  const outcome = await page.evaluate(async (inputs) => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="strict" tooldescription="Strict" toolautosubmit>
        <input name="text" value="original">
        <input name="count" type="number">
        <input name="agree" type="checkbox">
        <input name="tags" type="checkbox" value="a"><input name="tags" type="checkbox" value="b">
        <select name="pick"><option>a</option><option>b</option></select>
        <select name="many" multiple><option>x</option><option>y</option></select>
        <input name="day" type="date">
      </form>`;
    const events: string[] = [];
    context.addEventListener("toolactivated", () => events.push("toolactivated"));
    document.forms[0]!.addEventListener("input", () => events.push("input"));
    const [tool] = await context.getTools();
    const errors: Record<string, string> = {};
    for (const [label, input] of Object.entries(inputs)) {
      errors[label] = await context.executeTool(tool!, input).catch((error) => error.name);
    }
    const text = (document.forms[0]!.elements.namedItem("text") as HTMLInputElement).value;
    return { errors, events, text };
  }, invalidInputs);

  expect(outcome).toEqual({
    errors: Object.fromEntries(Object.keys(invalidInputs).map((label) => [label, "UnknownError"])),
    events: [],
    text: "original",
  });
});

test("month and week inputs accept only their formats in every browser", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="dates" tooldescription="Dates" toolautosubmit>
        <input name="month" type="month"><input name="week" type="week">
      </form>`;
    document.forms[0]!.addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve("filled"));
    });
    const [tool] = await context.getTools();
    const results: Record<string, string> = {};
    for (const [label, input] of Object.entries({
      month: { month: "2026-09" },
      monthName: { month: "September" },
      monthOutOfRange: { month: "2026-13" },
      week: { week: "2026-W38" },
      weekWithoutYear: { week: "W38" },
      week53: { week: "2020-W53" },
      week53OfShortYear: { week: "2025-W53" },
    })) {
      results[label] = await context.executeTool(tool!, input).catch((error) => error.name);
    }
    return results;
  });

  expect(outcome).toEqual({
    month: "filled",
    monthName: "UnknownError",
    monthOutOfRange: "UnknownError",
    week: "filled",
    weekWithoutYear: "UnknownError",
    week53: "filled",
    week53OfShortYear: "UnknownError",
  });
});

test("the call settles with the page's response, null for a navigation, or an error", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <iframe name="target"></iframe>
      <form toolname="submit" tooldescription="Submit" toolautosubmit action="/" target="target">
        <input name="query" required>
      </form>`;
    const form = document.forms[0]!;
    const [tool] = await context.getTools();
    const respond = (event: SubmitEvent, response: Promise<unknown>) => {
      event.preventDefault();
      event.respondWith(response);
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const handlers: [string, (event: SubmitEvent) => void][] = [
      ["navigation", () => {}],
      ["string", (event) => respond(event, Promise.resolve("plain"))],
      ["object", (event) => respond(event, Promise.resolve({ ok: true }))],
      ["number", (event) => respond(event, Promise.resolve(5))],
      ["undefined", (event) => respond(event, Promise.resolve(undefined))],
      [
        "after awaiting",
        async (event) => {
          event.preventDefault();
          await Promise.resolve();
          event.respondWith(Promise.resolve("responded late"));
        },
      ],
      ["circular", (event) => respond(event, Promise.resolve(circular))],
      ["rejected", (event) => respond(event, Promise.reject(new Error("failed")))],
      ["prevented", (event) => event.preventDefault()],
      [
        "form.submit()",
        (event) => {
          event.preventDefault();
          form.submit();
        },
      ],
    ];
    const results: Record<string, unknown> = {};
    for (const [label, handler] of handlers) {
      form.addEventListener("submit", handler, { once: true });
      results[label] = await context
        .executeTool(tool!, { query: "value" })
        .catch((error) => error.name);
    }
    let submitted = false;
    form.addEventListener("submit", () => (submitted = true));
    results.invalid = await context
      .executeTool(tool!, { query: "" })
      .catch((error) => error.name);
    return { results, submitted };
  });

  expect(outcome).toEqual({
    results: {
      navigation: null,
      string: "plain",
      object: '{"ok":true}',
      number: "5",
      undefined: "undefined",
      "after awaiting": "responded late",
      circular: "UnknownError",
      rejected: "UnknownError",
      prevented: "UnknownError",
      "form.submit()": null,
      invalid: "UnknownError",
    },
    submitted: false,
  });
});

test("SubmitEvent gains agentInvoked and respondWith() with Chromium's checks", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const errorName = (operation: () => unknown): string => {
      try {
        operation();
        return "none";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    };
    const prototype = SubmitEvent.prototype;
    const agentInvoked = Object.getOwnPropertyDescriptor(prototype, "agentInvoked")!;
    const respondWith = Object.getOwnPropertyDescriptor(prototype, "respondWith")!;
    const shape = {
      getter: {
        enumerable: agentInvoked.enumerable,
        configurable: agentInvoked.configurable,
        setter: agentInvoked.set,
      },
      method: {
        enumerable: respondWith.enumerable,
        writable: respondWith.writable,
        length: respondWith.value.length,
      },
      wrongBrand: {
        getter: errorName(() => agentInvoked.get!.call(new Event("submit"))),
        method: errorName(() => respondWith.value.call(new Event("submit"), Promise.resolve())),
      },
    };

    document.body.innerHTML = `
      <form toolname="agent" tooldescription="Agent" toolautosubmit><button>Go</button></form>
      <form id="page"><button>Go</button></form>`;
    const [agentForm, pageForm] = document.forms;
    const pageSubmission: Record<string, unknown> = {};
    pageForm!.addEventListener("submit", (event) => {
      pageSubmission.agentInvoked = event.agentInvoked;
      pageSubmission.respondWith = errorName(() => event.respondWith(Promise.resolve()));
      event.preventDefault();
    });
    pageForm!.requestSubmit();

    let saved: SubmitEvent | undefined;
    const agentSubmission: Record<string, unknown> = {};
    agentForm!.addEventListener("submit", (event) => {
      saved = event;
      agentSubmission.agentInvoked = event.agentInvoked;
      agentSubmission.beforePreventDefault = errorName(() => event.respondWith(Promise.resolve()));
      event.preventDefault();
      agentSubmission.withoutArguments = errorName(() =>
        Reflect.apply(respondWith.value, event, []),
      );
      // Web IDL converts any value to a promise; the last response wins.
      respondWith.value.call(event, "first");
      respondWith.value.call(event, "last");
    });
    const context = document.modelContext!;
    const [tool] = await context.getTools();
    const result = await context.executeTool(tool!, {});
    const late = errorName(() => saved!.respondWith(Promise.resolve("late")));
    return { shape, pageSubmission, agentSubmission, result, late };
  });

  expect(outcome).toEqual({
    shape: {
      getter: { enumerable: true, configurable: true, setter: undefined },
      method: { enumerable: true, writable: true, length: 1 },
      wrongBrand: { getter: "TypeError", method: "TypeError" },
    },
    pageSubmission: { agentInvoked: false, respondWith: "InvalidStateError" },
    agentSubmission: {
      agentInvoked: true,
      beforePreventDefault: "InvalidStateError",
      withoutArguments: "TypeError",
    },
    result: "last",
    late: "InvalidStateError",
  });
});

test("respondWith() throws once the agent's submission settles, even without a response", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const respond = (event: SubmitEvent): string => {
      try {
        event.respondWith(Promise.resolve("late"));
        return "none";
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
    };
    document.body.innerHTML = `
      <form toolname="late" tooldescription="Late" toolautosubmit></form>`;
    const form = document.forms[0]!;
    const context = document.modelContext!;
    const [tool] = await context.getTools();
    const submit = async (listener: (event: SubmitEvent) => void) => {
      let saved: SubmitEvent | undefined;
      form.addEventListener(
        "submit",
        (event) => {
          saved = event;
          listener(event);
        },
        { once: true },
      );
      const result = await context.executeTool(tool!, {}).catch((error) => error.name);
      return { result, agentInvoked: saved!.agentInvoked, late: respond(saved!) };
    };

    const prevented = await submit((event) => event.preventDefault());
    // As in Chromium, a response after a reset cancels the call is accepted and ignored.
    let afterReset = "";
    const reset = await submit((event) => {
      event.preventDefault();
      form.reset();
      afterReset = respond(event);
    });
    return { prevented, reset, afterReset };
  });

  const settled = { result: "UnknownError", agentInvoked: true, late: "InvalidStateError" };
  expect(outcome).toEqual({ prevented: settled, reset: settled, afterReset: "none" });
});

test("capture listeners added before or after installation see the agent's submission", async ({
  page,
}) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const seen: string[] = [];
    // Runs before the polyfill's listener, and responds before reading agentInvoked.
    addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        event.respondWith(Promise.resolve("responded"));
        seen.push(`before ${event.agentInvoked}`);
      },
      true,
    );
    const script = document.createElement("script");
    script.textContent = await (await fetch("/auto.js")).text();
    document.head.append(script);
    addEventListener("submit", (event) => seen.push(`after ${event.agentInvoked}`), true);
    document.body.innerHTML = `
      <form toolname="early" tooldescription="Early" toolautosubmit></form>`;
    const context = document.modelContext!;
    const [tool] = await context.getTools();
    return { result: await context.executeTool(tool!, {}), seen };
  });

  expect(outcome).toEqual({ result: "responded", seen: ["before true", "after true"] });
});

test("without autosubmit, the call waits for the user to submit with the focused button", async ({
  page,
}) => {
  const call = await page.evaluateHandle(async () => {
    document.body.innerHTML = `
      <form toolname="review" tooldescription="Review">
        <input name="note"><button>Send</button>
      </form>`;
    const form = document.forms[0]!;
    const input = form.elements[0] as HTMLInputElement;
    const context = document.modelContext!;
    let activated = "";
    context.addEventListener("toolactivated", () => {
      activated = `${document.activeElement?.localName} ${input.value}`;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve(`sent ${event.agentInvoked}`));
    });
    const [tool] = await context.getTools();
    return { result: context.executeTool(tool!, { note: "hello" }), activated: () => activated };
  });

  await expect(page.getByRole("button")).toBeFocused();
  await expect(page.locator("input")).toHaveValue("hello");
  // The form is filled, and not yet focused, when toolactivated fires.
  expect(await call.evaluate(({ activated }) => activated())).toBe("body hello");
  await page.getByRole("button").click();
  expect(await call.evaluate(({ result }) => result)).toBe("sent true");
});

test("without autosubmit or a submit button, the call rejects without filling the form", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="buttonless" tooldescription="No button"><input name="a"></form>`;
    const [tool] = await context.getTools();
    const result = await context.executeTool(tool!, { a: "1" }).catch((error) => error.name);
    return { result, value: (document.forms[0]!.elements[0] as HTMLInputElement).value };
  });

  expect(outcome).toEqual({ result: "UnknownError", value: "" });
});

test("the first enabled submit button in tree order submits, even from outside the form", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <button form="order" name="action" value="outside">Outside</button>
      <form id="order" toolname="order" tooldescription="Order" toolautosubmit>
        <input name="item"><button name="action" value="inside">Inside</button>
      </form>
      <input form="order" name="note">`;
    const form = document.forms[0]!;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve((event.submitter as HTMLButtonElement).value));
    });
    const [tool] = await context.getTools();
    const outside = await context.executeTool(tool!, { item: "tea", note: "hot" });
    document.querySelector("button")!.disabled = true;
    const inside = await context.executeTool(tool!, { item: "tea" });
    return {
      properties: Object.keys((tool!.inputSchema as { properties: object }).properties),
      outside,
      inside,
    };
  });

  expect(outcome).toEqual({ properties: ["item", "note"], outside: "outside", inside: "inside" });
});

test("the submit button is chosen after listeners react to the fill", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="swap" tooldescription="Swap" toolautosubmit>
        <input name="a"><button name="button" value="old">Go</button>
      </form>`;
    const form = document.forms[0]!;
    form.addEventListener("input", () => {
      const fresh = document.createElement("button");
      fresh.name = "button";
      fresh.value = "new";
      form.querySelector("button")!.replaceWith(fresh);
    });
    const submissions: string[] = [];
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = event.submitter as HTMLButtonElement;
      submissions.push(`${event.agentInvoked} ${submitter.value}`);
      if (event.agentInvoked) {
        event.respondWith(Promise.resolve(submitter.value));
      }
    });
    const [tool] = await context.getTools();
    const result = await context.executeTool(tool!, { a: "1" }).catch((error) => error.name);
    form.requestSubmit(form.querySelector("button"));
    return { result, submissions };
  });

  expect(outcome).toEqual({ result: "new", submissions: ["true new", "false new"] });
});

test("a toolactivated listener that submits the form itself completes the call once", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="eager" tooldescription="Eager" toolautosubmit><input name="a"></form>`;
    const form = document.forms[0]!;
    let submissions = 0;
    form.addEventListener("submit", (event) => {
      submissions++;
      event.preventDefault();
      const value = (form.elements[0] as HTMLInputElement).value;
      event.respondWith(Promise.resolve(`submitted ${value}`));
    });
    context.addEventListener("toolactivated", () => form.requestSubmit());
    const [tool] = await context.getTools();
    const result = await context.executeTool(tool!, { a: "1" });
    return { result, submissions };
  });

  expect(outcome).toEqual({ result: "submitted 1", submissions: 1 });
});

test("a reset, removal or new declaration cancels a waiting call; a new schema does not", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="reset" tooldescription="Reset"><input name="a"><button>Go</button></form>
      <form toolname="remove" tooldescription="Remove"><input name="a"><button>Go</button></form>
      <form toolname="rename" tooldescription="Rename"><input name="a"><button>Go</button></form>
      <form toolname="kept" tooldescription="Kept"><input name="a"><button>Go</button></form>
      <form toolname="grow" tooldescription="Grow"><input name="a"><button>Go</button></form>`;
    const tools = new Map((await context.getTools()).map((tool) => [tool.name, tool]));
    const form = (name: string) =>
      document.querySelector<HTMLFormElement>(`form[toolname="${name}"]`)!;
    const cancels: string[] = [];
    context.addEventListener("toolcancel", (event) => cancels.push(event.toolName));
    // The call is wrapped so that awaiting the start does not await the call.
    const start = async (name: string) => {
      const activated = new Promise<void>((resolve) => {
        context.addEventListener("toolactivated", () => resolve(), { once: true });
      });
      const call = context.executeTool(tools.get(name)!, { a: "1" }).then(
        (value) => `resolved ${value}`,
        (error) => error.name,
      );
      await Promise.race([activated, call]);
      return { call };
    };

    const reset = await start("reset");
    form("reset").reset();

    const removed = await start("remove");
    form("remove").remove();

    const rename = await start("rename");
    form("rename").setAttribute("tooldescription", "Renamed");

    const kept = await start("kept");
    form("kept").addEventListener("reset", (event) => event.preventDefault());
    form("kept").reset();
    form("kept").addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve("kept"));
    });
    form("kept").requestSubmit();

    // Chromium also cancels a call when the form's controls change.
    const grow = await start("grow");
    form("grow").insertAdjacentHTML("beforeend", `<input name="b">`);
    const grown = (await context.getTools()).find((tool) => tool.name === "grow")!;
    form("grow").addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve("grown"));
    });
    form("grow").requestSubmit();

    return {
      reset: await reset.call,
      removed: await removed.call,
      rename: await rename.call,
      kept: await kept.call,
      grow: await grow.call,
      properties: Object.keys((grown.inputSchema as { properties: object }).properties),
      cancels,
    };
  });

  expect(outcome).toEqual({
    reset: "UnknownError",
    removed: "UnknownError",
    rename: "UnknownError",
    kept: "resolved kept",
    grow: "resolved grown",
    properties: ["a", "b"],
    cancels: [],
  });
});

test("a reset right before the page's own submission cancels the call first", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="reset" tooldescription="Reset"><input name="a"><button>Go</button></form>`;
    const form = document.forms[0]!;
    let agentInvoked: boolean | undefined;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      agentInvoked = event.agentInvoked;
    });
    const activated = new Promise<void>((resolve) => {
      context.addEventListener("toolactivated", () => resolve(), { once: true });
    });
    const [tool] = await context.getTools();
    const call = context.executeTool(tool!, { a: "1" }).catch((error) => error.name);
    await activated;
    form.reset();
    form.requestSubmit();
    return { call: await call, agentInvoked };
  });

  expect(outcome).toEqual({ call: "UnknownError", agentInvoked: false });
});

test("an earlier submission read while a call waits does not become the agent's", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="earlier" tooldescription="Earlier"><button>Go</button></form>`;
    const form = document.forms[0]!;
    const events: SubmitEvent[] = [];
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      events.push(event);
    });
    form.requestSubmit();
    const activated = new Promise<void>((resolve) => {
      context.addEventListener("toolactivated", () => resolve(), { once: true });
    });
    const [tool] = await context.getTools();
    const call = context.executeTool(tool!, {}).catch((error) => error.name);
    await activated;
    const earlier = events[0]!.agentInvoked;
    form.requestSubmit();
    return { earlier, agent: events[1]!.agentInvoked, call: await call };
  });

  expect(outcome).toEqual({ earlier: false, agent: true, call: "UnknownError" });
});

test("a form moved into a shadow tree does not submit for the agent", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <div></div>
      <form toolname="moved" tooldescription="Moved"><button>Go</button></form>`;
    const form = document.forms[0]!;
    let submission = "";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        event.respondWith(Promise.resolve("from shadow"));
        submission = `${event.agentInvoked} responded`;
      } catch (error) {
        submission = `${event.agentInvoked} ${error instanceof Error ? error.name : error}`;
      }
    });
    const activated = new Promise<void>((resolve) => {
      context.addEventListener("toolactivated", () => resolve(), { once: true });
    });
    const [tool] = await context.getTools();
    const call = context.executeTool(tool!, {}).catch((error) => error.name);
    await activated;
    document.querySelector("div")!.attachShadow({ mode: "open" }).append(form);
    form.requestSubmit();
    return { submission, call: await call };
  });

  expect(outcome).toEqual({ submission: "false InvalidStateError", call: "UnknownError" });
});

test("a newer call rejects one that waits for the user, but not one the page is handling", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="echo" tooldescription="Echo" toolautosubmit><input name="a"></form>
      <form toolname="review" tooldescription="Review"><input name="a"><button>Go</button></form>`;
    for (const form of document.forms) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        event.respondWith(Promise.resolve((form.elements[0] as HTMLInputElement).value));
      });
    }
    const [echo, review] = await context.getTools();
    const settle = (promise: Promise<string | null>) =>
      promise.then(
        (value) => `resolved ${value}`,
        (error) => error.name,
      );
    const activated = () =>
      new Promise<void>((resolve) => {
        context.addEventListener("toolactivated", () => resolve(), { once: true });
      });
    let waiting = activated();
    // Chromium leaves the older call pending instead.
    const first = settle(context.executeTool(review!, { a: "1" }));
    await waiting;
    waiting = activated();
    const second = settle(context.executeTool(review!, { a: "2" }));
    await waiting;
    document.forms[1]!.requestSubmit();

    // The second call fills the form before the first call's submission settles.
    const echoes = await Promise.all(["1", "2"].map((a) => context.executeTool(echo!, { a })));
    return { first: await first, second: await second, echoes };
  });

  expect(outcome).toEqual({ first: "UnknownError", second: "resolved 2", echoes: ["1", "2"] });
});

test("a change during the agent's submit event keeps the call, a later one cancels it", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="inline" tooldescription="Removed during submit" toolautosubmit></form>
      <form toolname="reset" tooldescription="Reset while responding" toolautosubmit></form>
      <form toolname="remove" tooldescription="Removed while responding" toolautosubmit></form>`;
    const tools = new Map((await context.getTools()).map((tool) => [tool.name, tool]));
    const form = (name: string) =>
      document.querySelector<HTMLFormElement>(`form[toolname="${name}"]`)!;
    const cancels: string[] = [];
    context.addEventListener("toolcancel", (event) => cancels.push(event.toolName));
    const settle = (promise: Promise<string | null>) =>
      promise.then(
        (value) => `resolved ${value}`,
        (error) => error.name,
      );
    const respondLater = async (name: string) => {
      const { promise: response, resolve: respond } = Promise.withResolvers<string>();
      const submitted = new Promise<void>((resolve) => {
        form(name).addEventListener(
          "submit",
          (event) => {
            event.preventDefault();
            event.respondWith(response);
            resolve();
          },
          { once: true },
        );
      });
      const call = settle(context.executeTool(tools.get(name)!));
      await submitted;
      return { call, respond: () => respond("late") };
    };

    form("inline").addEventListener("submit", (event) => {
      event.preventDefault();
      event.respondWith(Promise.resolve("kept"));
      form("inline").remove();
    });
    const inline = settle(context.executeTool(tools.get("inline")!));

    // A reset or removal cancels every call that waits for a response, not only the latest.
    const older = await respondLater("reset");
    const newer = await respondLater("reset");
    // Discovery resolves after the polyfill has handled the submissions.
    await context.getTools();
    form("reset").reset();
    older.respond();
    newer.respond();

    const removed = [await respondLater("remove"), await respondLater("remove")];
    await context.getTools();
    form("remove").remove();
    await context.getTools();
    removed.forEach((call) => call.respond());

    return {
      inline: await inline,
      reset: [await older.call, await newer.call],
      removed: [await removed[0]!.call, await removed[1]!.call],
      cancels,
      tools: (await context.getTools()).map((tool) => tool.name),
    };
  });

  expect(outcome).toEqual({
    inline: "resolved kept",
    reset: ["UnknownError", "UnknownError"],
    removed: ["UnknownError", "UnknownError"],
    cancels: [],
    tools: ["reset"],
  });
});

test("aborting a declarative call fires toolcancel and releases its form", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    document.body.innerHTML = `
      <form toolname="review" tooldescription="Review"><input name="a"><button>Go</button></form>
      <form toolname="slow" tooldescription="Slow" toolautosubmit></form>`;
    const [reviewForm, slowForm] = document.forms;
    const events: string[] = [];
    for (const type of ["toolactivated", "toolcancel"] as const) {
      context.addEventListener(type, (event) => events.push(`${type} ${event.toolName}`));
    }
    const [review, slow] = await context.getTools();
    const abortAfter = async (
      tool: WebMCP.RegisteredTool,
      input: object,
      started: Promise<unknown>,
    ) => {
      const controller = new AbortController();
      const call = context
        .executeTool(tool, input, { signal: controller.signal })
        .catch((reason) => events.push(`rejected ${reason}`));
      await started;
      controller.abort("stop");
      await call;
      // Discovery resolves after the queued cancellation that fires toolcancel.
      await context.getTools();
    };

    const activated = new Promise((resolve) => {
      context.addEventListener("toolactivated", resolve, { once: true });
    });
    await abortAfter(review!, { a: "1" }, activated);
    let agentInvoked: boolean | undefined;
    reviewForm!.addEventListener("submit", (event) => {
      agentInvoked = event.agentInvoked;
      event.preventDefault();
    });
    reviewForm!.requestSubmit();

    const responding = new Promise<void>((resolve) => {
      slowForm!.addEventListener("submit", (event) => {
        event.preventDefault();
        event.respondWith(new Promise(() => {}));
        resolve();
      });
    });
    await abortAfter(slow!, {}, responding);
    return { events, agentInvoked };
  });

  expect(outcome).toEqual({
    events: [
      "toolactivated review",
      "rejected stop",
      "toolcancel review",
      "toolactivated slow",
      "rejected stop",
      "toolcancel slow",
    ],
    agentInvoked: false,
  });
});
