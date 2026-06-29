import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRunner } from '../src/runner.js';

// Fake child process: emits canned stdout then closes with `code`.
// `calls` (when provided) records the (bin, args) the runner spawned with.
function fakeSpawn(
  stdout: string,
  code: number | null = 0,
  calls?: Array<{ bin: string; args: string[] }>,
) {
  return (bin: string, args: string[]) => {
    calls?.push({ bin, args });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
}

describe('createRunner', () => {
  it('returns the assistant text from claude -p --output-format json', async () => {
    const json = JSON.stringify({ result: 'the rundown', is_error: false });
    const run = createRunner({ spawn: fakeSpawn(json), bin: 'claude', timeoutMs: 1000 });
    const out = await run('do the briefing');
    expect(out.text).toBe('the rundown');
    expect(out.ok).toBe(true);
  });

  it('marks ok=false on a non-zero exit', async () => {
    const run = createRunner({ spawn: fakeSpawn('', 1), bin: 'claude', timeoutMs: 1000 });
    const out = await run('x');
    expect(out.ok).toBe(false);
  });

  it('marks ok=false when exit is 0 but the JSON reports is_error', async () => {
    const json = JSON.stringify({ result: 'oops', is_error: true });
    const run = createRunner({ spawn: fakeSpawn(json, 0), bin: 'claude', timeoutMs: 1000 });
    const out = await run('x');
    expect(out.ok).toBe(false);
    expect(out.text).toBe('oops');
  });

  it('passes args in the exact order: -p --output-format json <prompt>', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const json = JSON.stringify({ result: 'ok', is_error: false });
    const run = createRunner({ spawn: fakeSpawn(json, 0, calls), bin: 'claude', timeoutMs: 1000 });
    await run('the prompt');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe('claude');
    expect(calls[0]?.args).toEqual(['-p', '--output-format', 'json', 'the prompt']);
  });
});
