# Code style guide

This describes the style the codebase already follows. Prettier and ESLint enforce what they can
(`npm run lint`, run in CI); the rest is by review. When this guide and the tools disagree, fix the guide
or the config in the same change.

## Tooling

- `npm run lint` runs ESLint (`eslint.config.js`) and `prettier --check`. `npm run format` rewrites files.
- Prettier settings: 120 columns, single quotes, semicolons, trailing commas everywhere, 2-space indent, LF line endings.
- Do not hand-format around Prettier. If its output reads badly, restructure the code.

## Language and dependencies

- Node 24+, ES modules (`import`/`export`), no CommonJS.
- **No runtime dependencies.** Use the built-ins: `fetch`, `WebSocket`, `FormData`, `node:sqlite`, `node:crypto`.
  Dev dependencies are allowed only for tooling and the mock server (`ws`, ESLint, Prettier).
- Import built-ins with the `node:` prefix. Local imports include the `.js` extension.

## Naming

- Files are lower-case, one concern each: `bridge.js`, `store.js`. Tests are `<topic>.test.js`.
- `camelCase` for variables and functions, `PascalCase` for classes, `UPPER_SNAKE` for module-level constants.
- Instance keys are called `inst`, channel IDs `chan`, message IDs `msg`; destination variants are prefixed `dst`
  (`dstInst`, `dstChan`), sources `src`. Database columns follow the same words in `snake_case`.
- Private class members use `#name`, not an underscore.

## Structure

- Prefer `const` and arrow functions for small helpers; use `class` for things with state (`Bridge`, `Store`, `FluxerClient`).
- One class per file. Pure helpers sit at the top of the file, above the class.
- Keep functions short and flat. Return early instead of nesting.
- Use `async`/`await`; do not mix with `.then` chains except where a promise chain is the point (the per-channel queues).
- Braces are optional only for a single-line statement. Once a body spans lines it gets braces (ESLint `curly: multi-line`).
- `===` always, except `== null` to test for null or undefined.

## Data and correctness

- **Snowflake IDs are strings.** Never parse them as numbers. Compare with `BigInt` when order matters.
- Every event handler and request error is caught, logged and isolated. One failing destination must not affect others.
- Messages to a destination go through its queue so order is preserved.
- Return `null` for "not found"; throw for failure. Errors carry `status` and `code` when they come from HTTP.
- Do not log secrets (tokens, webhook tokens).
- Logging goes through the injected `log` function. `console` is allowed only in `src/index.js` and tests.

## Comments

- Comment **why**, not what. A comment states a constraint, a trade-off or a non-obvious API behaviour.
- Doc comments (`/** ... */`) on classes and non-obvious methods, one or two lines. No tag boilerplate (`@param`) unless the types are not obvious.
- End-of-line comments are short and sit after the code they explain.
- No commented-out code, no TODOs without an issue or an `openspec/changes/` entry.

## Tests

- `node:test` with `node:assert/strict`. One test file per spec capability; the file's first line names the spec it covers.
- Test names follow the spec scenarios, in plain sentences (`it('adds the reaction to each copy', ...)`).
- Tests run against the in-process mock instance (`test/helpers/mock-instance.js`). Extend the mock rather than stubbing `fetch`.
- No real network, no real sleeps beyond the knobs on `FluxerClient`. Wait with `waitFor` or `bridge.idle()`.
- Tests clean up after themselves (`h.cleanup()`).

## Specs and docs

- Behaviour lives in `openspec/specs/`; proposed behaviour in `openspec/changes/`. Requirements use SHALL and every
  requirement has at least one scenario.
- `README.md` describes what works today, not plans.
- Markdown, YAML and JSON follow the surrounding file. Prefer short paragraphs and tables over long prose.

## Commits

- Conventional prefix (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`), imperative mood, subject under 72 characters.
- One logical change per commit, with its tests and spec updates.
