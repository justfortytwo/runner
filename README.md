# @justfortytwo/runner

Thin shared library that wraps headless `claude -p --output-format json` invocations for fortytwo daemons and bridges.

## Usage

```ts
import { createRunner } from '@justfortytwo/runner';

const run = createRunner(); // uses `claude` binary from PATH or CLAUDE_BIN env
const result = await run('What is the weather in Paris?');
if (result.ok) {
  console.log(result.text);
}
```

## API

### `createRunner(opts?: RunnerOptions): (prompt: string, extraArgs?: string[]) => Promise<RunResult>`

Creates a runner function. Options:

- `spawn` — injectable child_process.spawn (useful for testing)
- `bin` — path to the `claude` binary (default: `CLAUDE_BIN` env or `"claude"`)
- `timeoutMs` — turn timeout in ms (default: `FORTYTWO_TURN_TIMEOUT` env × 1000, or 300 000 ms)
- `cwd` — working directory for the subprocess

### `RunResult`

```ts
interface RunResult {
  ok: boolean;    // true if exit code 0 and is_error is not set
  text: string;   // the `result` field from claude's JSON output
  raw: unknown;   // the full parsed JSON (or null on parse error)
}
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Path to the claude CLI binary |
| `FORTYTWO_TURN_TIMEOUT` | `300` | Turn timeout in seconds |
