# @justfortytwo/runner

A small lifecycle and transport layer around Claude Code. Supports one-shot jobs
and persistent JSONL sessions. Claude Code owns agent execution, tools, permissions,
subagents, MCP, plugins, and memory. Callers own channels, scheduling, profiles,
and persistence.

## One-shot jobs

```ts
import { createRunner } from '@justfortytwo/runner';

const runner = createRunner(); // CLAUDE_BIN or "claude" from PATH
const result = await runner.run({
  prompt: 'Summarize this repository',
  cwd: '/path/to/project',
  args: ['--model', 'my-model'],
  env: { ANTHROPIC_BASE_URL: 'https://provider.example' },
});
```

`run()` returns `RunResult`: `{ ok: boolean, text: string, raw: unknown }`.
`ok` requires exit code zero and no `is_error` in Claude's JSON. Invalid JSON
returns `ok: false`, the output as `text`, and `raw: null`. Spawn failures reject
with `RunnerSpawnError`; invalid input/options reject with `TypeError`.

`createRunner()` returns an object with `run()` and `createSession()` methods.
One-shot output is collected until exit.

## Persistent sessions

```ts
import { createInterface } from 'node:readline';
import { createRunner } from '@justfortytwo/runner';

const runner = createRunner();
const session = await runner.createSession({
  cwd: '/path/to/project',
  env: { ANTHROPIC_BASE_URL: 'https://provider.example' },
  args: ['--model', 'my-model'],
  // resumeSessionId: previouslySavedId,
});

session.on('assistant', message => console.log(message.text));
session.on('result', result => console.log(result.text));
session.on('error', error => console.error(error));
session.on('event', event => {
  // raw, assistant, result, stderr, exit, or error
});

// The caller supplies user turns and controls the session lifetime.
const input = createInterface({ input: process.stdin });
try {
  for await (const text of input) {
    if (text.trim()) await session.send(text);
  }
} finally {
  input.close();
  await session.close();
}
```

Creation resolves on OS process spawn; `ready` means writable, not authenticated
or fully initialized by Claude. `send(text)` writes one user JSONL message and
resolves after its stdin write completes, **not** after a response. Listen for
`result` to observe completion of a turn. Concurrent sends serialize writes in
invocation order; Claude controls processing of queued turns. Empty/whitespace,
non-string and NUL-containing inputs reject. New and queued writes reject once
closing begins. Broken stdin is reported with `RunnerClosedError`.

Output is decoded incrementally as UTF-8 JSONL, including fragmented lines and
an unterminated final line. Unknown valid events remain accessible. Malformed
lines produce a raw string and `RunnerProtocolError` (with `.line` and `.cause`),
and parsing continues. Stderr is diagnostic, not automatically fatal.

Events:

| Listener | Payload |
| --- | --- |
| `event` | `RunnerEvent` discriminated union of all events |
| `raw` | Parsed Claude event, or original malformed line |
| `assistant` | `{ type: 'assistant', text, raw }` for text in assistant messages |
| `result` | `RunResult` for each Claude result event |
| `stderr` | Text chunk |
| `exit` | `{ type: 'exit', code, signal }`, after output cleanup |
| `error` | `Error` |

Partial token events, tool blocks, and other protocol details are available via
`raw`; assistant normalization does not duplicate token deltas. Session result
`ok` reflects Claude's turn result; a later process failure is reported separately
via `exit` and state. Errors always appear on `event`; an absent `error` listener
does not trigger EventEmitter's fatal unhandled-error behavior. Events are live
and are not replayed or retained.

Session properties: `state` (`starting`, `ready`, `running`, `closed`, `failed`),
`sessionId`, `startedAt` and `lastActivityAt` (epoch milliseconds), `exitCode`,
`exitSignal`, and a copied/frozen runtime `config`. Session IDs are captured from
Claude output; the runner neither stores them nor implements conversation memory.
Configuration includes environment values: callers should not log it.

`close()` is idempotent. It rejects outstanding writes, ends stdin, waits
`shutdownGraceMs`, sends SIGTERM, then sends SIGKILL after another grace period.
It resolves after the parent process is reaped and output is closed. Results may
continue arriving during graceful shutdown. After parent exit, pipe draining is
bounded by the same grace period so inherited pipes cannot hang cleanup; output
arriving beyond that period is discarded. Only the parent Claude process is
owned/signaled: descendants remain Claude's responsibility. No detached process,
daemon, global session registry, or process-tree orchestration is created.
The caller must keep its own process alive and close sessions during shutdown.

## Options

`createRunner(defaults)` accepts:

- `bin`: executable path; defaults to `CLAUDE_BIN` or `claude`.
- `spawn`: injectable `child_process.spawn` implementation for tests.
- `cwd`, `env`, `args`, `resumeSessionId`, `shutdownGraceMs`: runtime defaults.
- `timeoutMs`: optional one-shot **wall-clock** limit.

`run({ prompt, ...options })` and `createSession(options)` accept the runtime
options. `run` also accepts a per-job `timeoutMs`. Per-call arguments append to
default arguments; environment overlays are copied onto the parent environment
(defaults first, per-call values last). Caller objects are never mutated.
`shutdownGraceMs` defaults to 1000 ms. Durations must be finite, nonnegative,
and within Node's timer range. `timeoutMs: 0` means an immediate timeout.

One-shot jobs have no timeout unless `timeoutMs` is explicitly set. Application
environment variables such as `FORTYTWO_TURN_TIMEOUT` are not interpreted; callers
resolve their configuration before creating the runner. A timeout returns
`{ ok: false, text: '', raw: null }` after termination and cleanup. This is not an inactivity timeout. Persistent
sessions ignore one-shot timeout settings and have no automatic time limit.

Command arguments are centralized and passed with `shell: false`. Streaming uses
`-p --input-format stream-json --output-format stream-json --verbose`; resumption
adds `--resume <id>`. The runner owns format flags and rejects conflicting format
arguments. No permission bypass flags are added. All other Claude configuration,
including compatible providers, is passed through without provider branches.
See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

## Runtime design

See [Runtime lifecycle and transport](docs/runtime.md) for component boundaries,
state semantics, shutdown behavior, and session resumption.

## Development

```sh
npm ci
npm test
npm run build
```

Tests use a local fake executable and controlled streams; no Claude installation,
API credentials, or network access is required for the test suite.
