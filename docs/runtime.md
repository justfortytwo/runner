# Runtime lifecycle and transport

`createRunner(defaults)` returns a plain object with two methods:

```ts
const result = await runner.run({ prompt, cwd, env, args });
const session = await runner.createSession({ cwd, env, args, resumeSessionId });
```

The runner owns the parent Claude Code process and its transport. Claude Code
owns agent execution, tool permissions, subagents, MCP, plugins, and memory.
Callers own configuration resolution, scheduling, channels, and persistence.
There is no global session registry or orchestration layer.

## Components

| Module | Responsibility |
| --- | --- |
| `src/runner.ts` | Runner factory and one-shot execution/result parsing |
| `src/command.ts` | Runtime option snapshots, validation, argument construction |
| `src/session.ts` | Session state, serialized input, JSONL parsing, output events |
| `src/lifecycle.ts` | Shutdown escalation and bounded output draining |
| `src/errors.ts` | Spawn, protocol, and closed-input errors |
| `src/index.ts` | Public exports |

Each session owns its child, input queue, parser, timestamps, identity, exit
information, and configuration snapshot. Independent sessions share no mutable
runtime state. Environment overlays and argument arrays are copied. Spawn uses
an argument array, `shell: false`, and piped standard streams.

## Input and output

`send(text)` serializes a Claude user message as one JSONL record:

```json
{"type":"user","session_id":"","message":{"role":"user","content":"hello"},"parent_tool_use_id":null}
```

The session ID is included when known. Concurrent sends preserve invocation
order and wait for each write callback before starting the next write. Their
promises acknowledge transport, not turn completion. A `result` event announces
Claude's turn result. The runner does not add request correlation, retries,
turn scheduling, or an agent loop.

Stdout is parsed incrementally, preserving UTF-8 characters across chunks. Each
valid line produces a raw event; assistant text and result messages also produce
normalized events. Unknown event shapes remain available through raw events.
Malformed lines produce their original text and a `RunnerProtocolError`, then
parsing continues. Stderr is forwarded without marking the session failed.
Events are not buffered for later subscribers.

## State and activity

| State | Meaning |
| --- | --- |
| `starting` | Child created; OS spawn confirmation pending |
| `ready` | Process spawned, with no locally outstanding turns |
| `running` | At least one turn written without a matching result yet |
| `closed` | Parent exited successfully or shutdown was requested |
| `failed` | Spawn/input failure or unexpected unsuccessful parent exit |

`createSession()` resolves on OS spawn, not on Claude initialization or provider
authentication. Register output listeners before sending turns. State is a small
lifecycle summary; it does not model Claude's internal execution. During shutdown,
new writes reject immediately even though the visible state may remain `ready`
or `running` until exit. An input failure prevents further writes, but callers
must still close the session to terminate a parent that remains alive.

`startedAt` and `lastActivityAt` are epoch milliseconds. Activity includes writes,
stdout chunks, stderr, and final process cleanup. `exitCode` and `exitSignal` are
null until known. A result's `ok` concerns that turn; the later parent exit is a
separate event.

## Shutdown and time limits

`close()` is idempotent and returns the same completion promise. It rejects
outstanding writes and ends stdin. If the parent remains alive after
`shutdownGraceMs` (default 1000 ms), it sends SIGTERM, then SIGKILL after another
grace period. Completion waits for the parent to be reaped and streams to close.

After parent exit, output pipes have a bounded grace period to drain. They are
then destroyed so descendants inheriting those pipes cannot block completion.
Late descendant output is discarded. Descendant processes are not owned or
signaled by the runner; Claude remains responsible for them. No detached process
or process-group supervision is introduced.

Persistent sessions have no automatic timeout. One-shot `timeoutMs` is an
explicit wall-clock limit, not an inactivity limit. On timeout, SIGTERM is sent
immediately, with SIGKILL escalation after the grace period; `run()` resolves an
unsuccessful result after cleanup. There is no implicit five-minute timeout and
no interpretation of application-specific timeout environment variables.

## Resumption and providers

Capture `session.sessionId` after a raw or normalized output event exposes it,
and store it in the calling application. Pass it to a later session:

```ts
const resumed = await runner.createSession({
  cwd: projectDirectory,
  resumeSessionId: savedSessionId,
  env: providerEnvironment,
});
```

This constructs `--resume <id>`; Claude performs the actual resumption. The runner
neither persists IDs nor guarantees that a requested conversation exists.
Provider configuration is passed through environment variables and CLI arguments,
without provider-specific branches or profile resolution.

## Validation

The test suite uses a local fake Claude executable plus controlled streams. It
covers one-shot results, process startup and exit, concurrent turns and sessions,
UTF-8 fragmentation, malformed JSONL, session IDs, resume arguments, environment
passing, broken input, shutdown escalation, inherited pipes, and explicit timeout
configuration. Run `npm test` and `npm run build`; normal tests require no Claude
installation or API access.
