# Working on the polyfill

This package implements the document-local imperative WebMCP draft. Use the
official `webmcp-types` dependency; do not duplicate its declarations.
No MCP server, transport, extension product, navigator aliases, or legacy API
compatibility belongs here.

## Before changing behavior

1. Read the live [Community Group draft](https://webmachinelearning.github.io/webmcp/)
   and the diff from the source revision recorded in TESTING.md.
2. Read the relevant upstream WPT, including its helpers and IDL. The pin is in
   `wpt/revision.txt`, selection in `wpt/run.ts`, and disagreements in TESTING.md.
3. Check browser evidence using the source map in TESTING.md. A Chromium test,
   browser issue, or standards-position discussion alone is not the specification.
4. Add the smallest real-browser regression that demonstrates the behavior.
   Tests load the built bundle from a real server; do not replace DOM APIs,
   page requests, or tool callbacks with mocks.

## Validate

Run `pnpm test`, `pnpm test:package`, and `pnpm test:wpt`. TESTING.md has the
prerequisites and says what each suite covers. Type checking runs over the test
code and the published declarations, not just `src/index.ts`. A missing browser or
driver must fail its project, never become a skipped test. Do not count an
excluded test as a pass, and do not add compatibility behavior only to satisfy
one.

When updating the WPT revision, read the upstream diff first, update the coverage
counts in `wpt/run.ts`, and inspect every changed assertion and expectation. Do not
regenerate failure metadata without reading each one. In the pull request
description, record the draft and WPT revisions, browser versions, passes,
expected failures, and excluded behavior separately. Keep upstream tests
unmodified and do not claim full conformance.

## Code

Favor a clear reading order over minimum line count. Use braces, name intermediate
values by their role, and keep argument conversion separate from tool operations.
Put the public entry point and operations before their lower-level helpers.

Web IDL conversion accepts unknown values and broad objects, and feature
detection needs runtime checks. Do not narrow either one to satisfy a lint rule.
Keep casts at conversion boundaries, state the invariant each one checks, and use
the upstream types and concrete return types inside the implementation.
