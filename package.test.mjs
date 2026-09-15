import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const consumer = mkdtempSync(join(tmpdir(), "webmcp-consumer-"));
const root = fileURLToPath(new URL(".", import.meta.url));
function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
try {
  run("pnpm", ["pack", "--pack-destination", consumer], root);
  const archive = readdirSync(consumer).find((name) => name.endsWith(".tgz"));
  assert.ok(archive, "pnpm pack produced no tarball");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Resolve declared dependencies with a fresh metadata cache, as a clean CI runner does.
  run("pnpm", [
    "add",
    "--cache-dir",
    join(consumer, "cache"),
    "--ignore-scripts",
    join(consumer, archive),
  ]);
  const installed = join(consumer, "node_modules/webmcp-polyfill");
  const files = readdirSync(installed, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(installed, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(files, [
    "LICENSE",
    "README.md",
    "dist/auto.d.ts",
    "dist/auto.js",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/polyfill.js",
    "package.json",
  ]);
  assert.match(
    readFileSync(join(installed, "dist/polyfill.js"), "utf8"),
    /SPDX-License-Identifier: MIT/,
    "dist/polyfill.js lost its licence banner: check esbuild's --legal-comments=inline",
  );
  // Compile an auto-only consumer: source files in this checkout cannot supply
  // missing ambient declarations or mask broken package exports.
  writeFileSync(
    join(consumer, "consumer.ts"),
    `
    import 'webmcp-polyfill/auto';
    const context: WebMCP.ModelContext | undefined = document.modelContext;
    void context?.registerTool({ name: 'typed', description: 'Typed',
      inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      execute(input) {
        const count: number = input.count;
        // @ts-expect-error inferred count must not become any
        const invalid: string = input.count;
        return { count };
      },
    });
    async function invoke(context: WebMCP.ModelContext) {
      const [tool] = await context.getTools();
      const result: string = await context.executeTool(tool, { count: 1 });
      // @ts-expect-error legacy JSON-string input is not supported
      await context.executeTool(tool, '{}');
      return result;
    }
  `,
  );
  for (const [module, moduleResolution] of [
    ["NodeNext", "NodeNext"],
    ["ESNext", "Bundler"],
  ]) {
    run(process.execPath, [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      module,
      "--moduleResolution",
      moduleResolution,
      "consumer.ts",
    ]);
  }
  run(process.execPath, [
    "--input-type=module",
    "-e",
    "import { installWebMCP } from 'webmcp-polyfill'; import 'webmcp-polyfill/auto'; installWebMCP();",
  ]);
  console.log(
    "Packed consumer: public types, inference, SSR imports, and package contents passed.",
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
