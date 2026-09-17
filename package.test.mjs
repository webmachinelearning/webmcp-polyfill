import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const consumerDirectory = mkdtempSync(join(tmpdir(), "webmcp-consumer-"));
const packageDirectory = fileURLToPath(new URL(".", import.meta.url));

try {
  run("pnpm", ["pack", "--pack-destination", consumerDirectory], packageDirectory);
  const archive = readdirSync(consumerDirectory).find((name) => name.endsWith(".tgz"));
  assert.ok(archive, "pnpm pack produced no tarball");
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );

  // Resolve published dependencies without this checkout's cached registry metadata.
  run("pnpm", [
    "add",
    "--cache-dir",
    join(consumerDirectory, "cache"),
    "--ignore-scripts",
    join(consumerDirectory, archive),
  ]);

  const installedPackage = join(consumerDirectory, "node_modules/webmcp-polyfill");
  const files = readdirSync(installedPackage, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = relative(installedPackage, join(entry.parentPath, entry.name));
      return path.replaceAll("\\", "/");
    })
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
    readFileSync(join(installedPackage, "dist/polyfill.js"), "utf8"),
    /SPDX-License-Identifier: MIT/,
    "dist/polyfill.js lost its licence banner: check esbuild's --legal-comments=inline",
  );

  // Compile outside this checkout so its source files cannot mask missing public types.
  writeFileSync(
    join(consumerDirectory, "consumer.ts"),
    `
    import 'webmcp-polyfill/auto';

    const context: WebMCP.ModelContext | undefined = document.modelContext;
    void context?.registerTool({
      name: 'typed',
      description: 'Typed',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
      execute(input) {
        const count: number = input.count;
        // @ts-expect-error The schema infers count as a number.
        const invalid: string = input.count;
        return { count };
      },
    });

    async function invoke(context: WebMCP.ModelContext) {
      const [tool] = await context.getTools();
      const result: string = await context.executeTool(tool, { count: 1 });
      // @ts-expect-error The current draft accepts objects, not serialized JSON.
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
      join(packageDirectory, "node_modules/typescript/bin/tsc"),
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
    `
      import { installWebMCP } from 'webmcp-polyfill';
      import 'webmcp-polyfill/auto';
      installWebMCP();
    `,
  ]);
  console.log(
    "Packed consumer: public types, inference, SSR imports, and package contents passed.",
  );
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true });
}

function run(command, args, cwd = consumerDirectory) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
