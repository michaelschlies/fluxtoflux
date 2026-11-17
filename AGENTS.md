# Working in this repository

Instructions for any AI agent (and a useful checklist for people) making changes to fluxtoflux.
Read `openspec/project.md` first for the purpose, architecture and constraints.

## 1. Use OpenSpec for every behaviour change

- Behaviour is specified in `openspec/specs/<capability>/spec.md`. Proposed changes live in `openspec/changes/<change-id>/`.
- **Before writing code** for a new feature, a behaviour change or a bug fix that alters behaviour, create or update a change:
  - `proposal.md`: why, what changes, impact
  - `tasks.md`: a checklist, ticked as you go
  - `specs/<capability>/spec.md`: `## ADDED`/`## MODIFIED`/`## REMOVED Requirements` deltas
- Requirements use **SHALL**, and every requirement has at least one `#### Scenario:` with **WHEN** and **THEN**.
- When the change is implemented and merged, move its requirements into `openspec/specs/` and remove the change folder.
  The `README.md` "What syncs" table and `openspec/project.md` stay in line with the specs.
- Pure refactors, formatting, tooling and docs that change no behaviour do not need a change, but say so in the commit.

## 2. Every feature has test coverage

- Every requirement scenario has a test, named after the scenario. No feature, option or fix is done without it.
- A bug fix starts with a failing regression test.
- Tests run against the mock instance in `test/helpers/mock-instance.js`. If the mock lacks a route or event you need, extend it.
- Run `npm test` and `npm run coverage` before finishing. Do not lower coverage; new code in `src/` should be covered
  except for code that cannot run portably in tests (signal handlers).
- If a test fails, report it with the output. Do not weaken, skip or delete a test to make it pass unless the spec changed.

## 3. Follow the code style guide

- `STYLE.md` is the style guide. Read it before writing code.
- Run `npm run lint` (ESLint and Prettier) and fix everything it reports. `npm run format` fixes formatting. CI runs the same check and fails the build.
- Match the surrounding code: naming, comment density and idiom. Do not reformat code you are not changing.
- No runtime dependencies. Do not add a package to `dependencies`; justify any new dev dependency in the change.

## 4. Verify against the real API, not memory

- The Fluxer API docs are in the `fluxerapp/fluxer` repository under `fluxer_docs/src/content/docs`
  (`http-api/`, `gateway/`, `media-proxy/`, `topics/`). Read the relevant page before using a route, event or field.
- Record what you could not verify in the change's `proposal.md` under "Open questions" instead of guessing.
- This bridge is tested against a mock. Say so when reporting results; do not claim it works against a live instance unless you ran it.

## 5. Working rules

- Snowflake IDs are strings, always. Compare with `BigInt` when ordering.
- One failing destination must never stop delivery to the others. Handlers log and isolate errors.
- Never log or commit tokens, webhook URLs or `config.json`. `data/` and `config.json` are git-ignored; keep it that way.
- Keep changes small and focused. Do not add features, options or abstractions that no requirement asks for.
- Prefer editing existing files to creating new ones. Put temporary files outside the repository.

## 6. Definition of done

A change is done when all of these hold:

1. An OpenSpec change (or updated spec) describes the behaviour, with scenarios.
2. Each scenario has a passing test, and `npm test` passes.
3. `npm run lint` passes.
4. `README.md` and the specs match what the code now does.
5. The commit message uses a conventional prefix (see `STYLE.md`) and mentions the change id.
6. The final report states what was verified, what was not (live instance, Docker, Helm), and any failing or skipped step.

## 7. Releases

Releases are tag-driven; see "Releasing" in `README.md`. Do not tag or push a release unless asked.
