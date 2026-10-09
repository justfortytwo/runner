# AGENTS.md — @justfortytwo/runner

Guidance for AI coding agents working in this repository.

## Purpose

`@justfortytwo/runner` is a thin lifecycle and JSONL transport layer around the
Claude Code CLI (`claude`). It supports:

- **One-shot jobs** — `runner.run({ prompt, ... })` spawns `claude -p --output-format json`
  and returns `RunResult { ok, text, raw }`.
- **Persistent sessions** — `runner.createSession(...)` spawns
  `claude -p --input-format stream-json --output-format stream-json --verbose`
  and exposes an event-emitting `RunnerSession`.

Scope boundary (keep it): Claude Code owns agent execution, tools, permissions,
subagents, MCP, plugins and memory. Callers own config resolution, scheduling,
channels and persistence. The runner adds no retries, agent loop, request
correlation, session registry, daemon or provider-specific branches.

## Layout

```
src/
  index.ts      Public exports (only surface consumers may rely on)
  runner.ts     createRunner factory, one-shot execution + result parsing
  command.ts    Option types, option merging/validation, CLI argument construction
  session.ts    RunnerSession: state, serialized stdin writes, JSONL parsing, events
  lifecycle.ts  Shutdown escalation (EOF -> SIGTERM -> SIGKILL), bounded drain
  errors.ts     RunnerSpawnError, RunnerClosedError, RunnerProtocolError
test/
  runner.test.ts       One-shot tests (mostly via injected fake `spawn`)
  session.test.ts      Session tests against a real child process
  fixtures/claude.mjs  Fake `claude` binary driven by magic prompts
docs/runtime.md        Runtime design: components, states, shutdown, resumption
```

`dist/` is build output (gitignored, published via `files`).

## Commands (from package.json)

```sh
npm ci              # install (package-lock.json is committed)
npm test            # vitest run
npm run test:watch  # vitest watch mode
npm run build       # tsc -p tsconfig.json -> dist/
npx tsc -p tsconfig.json --noEmit   # typecheck only
```

There is no lint or format script and no CI workflow in this repo. Verify
changes with `npm test` and the typecheck/build. Node `>=20` is required.

## Code conventions

- TypeScript, ESM (`"type": "module"`), `module`/`moduleResolution: NodeNext`:
  relative imports **must** use the `.js` extension (`from './runner.js'`).
- `strict` + `noUncheckedIndexedAccess` are on; handle possibly-undefined index access.
- Only runtime dependency is Node itself; dev deps are `typescript`, `vitest`,
  `@types/node`. Do not add runtime dependencies without good reason.
- Code style is compact: small exported functions, no classes beyond
  `RunnerSession` and the error types. Match the surrounding density.
- Invalid input/options throw `TypeError` (e.g. empty/NUL prompts, bad durations,
  conflicting format args). Spawn failures reject with `RunnerSpawnError`.
- Never mutate caller objects: copy `args` arrays and `env` overlays.
- New public API must be exported from `src/index.ts` and documented in
  `README.md` (and `docs/runtime.md` if it affects lifecycle/transport).

## Architecture notes

- Options merge: per-call `args` append to default `args`; `env` is
  `{ ...process.env, ...defaults.env, ...options.env }`. `bin` defaults to
  `CLAUDE_BIN` env var or `claude` on PATH.
- Spawn always uses an argument array with `shell: false` and piped stdio.
  The runner owns `--input-format`/`--output-format` and rejects them in `args`.
  It never adds permission-bypass flags.
- `--resume <id>` is added when `resumeSessionId` is set; session IDs are
  captured from Claude output, never persisted by the runner.
- Session states: `starting`, `ready`, `running`, `closed`, `failed`.
  `createSession()` resolves on OS spawn, not on Claude readiness.
- `send(text)` resolves when the stdin write completes, **not** when Claude
  responds; listen for `result` events. Concurrent sends are serialized.
- Stdout is decoded incrementally as UTF-8 JSONL (handles split multibyte chars,
  `\r\n`, unterminated last line). Malformed lines emit a raw string plus a
  `RunnerProtocolError`; parsing continues. Stderr is diagnostic, not fatal.
- Errors are always emitted on `event`; a missing `error` listener must not
  crash the process (avoid EventEmitter's unhandled-`error` behavior).
- `close()` is idempotent: rejects pending writes, ends stdin, waits
  `shutdownGraceMs` (default 1000), SIGTERM, then SIGKILL. Only the parent
  `claude` process is signaled; post-exit pipe draining is bounded.
- One-shot `timeoutMs` is an explicit wall-clock limit (no default); timeouts
  return `{ ok: false, text: '', raw: null }`. Sessions have no time limit.
  App env vars like `FORTYTWO_TURN_TIMEOUT` are intentionally **not** read here.

## Testing gotchas

- `test/session.test.ts` resolves the fixture with `resolve('test/fixtures/claude.mjs')`,
  so run tests from the repo root.
- The fixture changes behavior based on the user message text (`fragment`,
  `inherited-pipes`, `exit`, `bad`, `stubborn`) or a final one-shot arg of
  `hang`. Extend it the same way when adding lifecycle tests.
- Tests never call the real `claude` binary; keep it that way.

## Relation to sibling repos

This is one package of **fortytwo** (`@justfortytwo/*`), checked out alongside
siblings in `../` (gate, memory, persona, salience, scheduler, telegram,
installer, marketplace, docs, website). Each is its own git repo; edit only
this one unless asked. Known consumers:

- `../telegram` depends on it via `"file:../runner"` (local path).
- `../scheduler` depends on `"@justfortytwo/runner": "^0.1.0"`; note this
  package is now `1.0.0-0`, so API changes may need coordinated updates there.

Keep the public API in `src/index.ts` stable or update consumers deliberately.

## Repo hygiene

- `CLAUDE.md`, `.claude/` and `.wolf/` are currently untracked local tooling
  (OpenWolf); do not commit them unless asked.
- `.codegraph/`, `dist/`, `node_modules/`, `.env` are gitignored.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.
