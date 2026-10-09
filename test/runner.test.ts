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
    const runner = createRunner({ spawn: fakeSpawn(json), bin: 'claude', timeoutMs: 1000 });
    const out = await runner.run({ prompt: 'do the briefing' });
    expect(out.text).toBe('the rundown');
    expect(out.ok).toBe(true);
  });

  it('marks ok=false on a non-zero exit', async () => {
    const runner = createRunner({ spawn: fakeSpawn('', 1), bin: 'claude', timeoutMs: 1000 });
    const out = await runner.run({ prompt: 'x' });
    expect(out.ok).toBe(false);
  });

  it('marks ok=false when exit is 0 but the JSON reports is_error', async () => {
    const json = JSON.stringify({ result: 'oops', is_error: true });
    const runner = createRunner({ spawn: fakeSpawn(json, 0), bin: 'claude', timeoutMs: 1000 });
    const out = await runner.run({ prompt: 'x' });
    expect(out.ok).toBe(false);
    expect(out.text).toBe('oops');
  });

  it('passes args in the exact order: -p --output-format json <prompt>', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const json = JSON.stringify({ result: 'ok', is_error: false });
    const runner = createRunner({ spawn: fakeSpawn(json, 0, calls), bin: 'claude', timeoutMs: 1000 });
    await runner.run({ prompt: 'the prompt' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe('claude');
    expect(calls[0]?.args).toEqual(['-p', '--output-format', 'json', 'the prompt']);
  });
});

it('passes copied provider environment and extra arguments without a shell', async () => {
  let captured: any;
  const env = Object.freeze({ ANTHROPIC_BASE_URL: 'https://compatible.example', TEST_MARKER: 'default' });
  const spawn: any = (bin: string, args: string[], options: any) => {
    captured = { bin, args, options };
    return fakeSpawn('{"result":"ok"}')(bin, args);
  };
  const runner = createRunner({ spawn, env, args: ['--model', 'custom'] });
  await runner.run({ prompt: 'literal $(command); text', cwd: '/tmp', env: { TEST_MARKER: 'call' }, args: ['--max-turns', '2'], resumeSessionId: 'session-id' });
  expect(captured.options.shell).toBe(false);
  expect(captured.options.cwd).toBe('/tmp');
  expect(captured.options.env.ANTHROPIC_BASE_URL).toBe(env.ANTHROPIC_BASE_URL);
  expect(captured.options.env.TEST_MARKER).toBe('call');
  expect(env.TEST_MARKER).toBe('default');
  expect(captured.args).toEqual(['-p', '--output-format', 'json', '--model', 'custom', '--max-turns', '2', '--resume', 'session-id', 'literal $(command); text']);
});

it('rejects invalid durations and protocol overrides before spawning', async () => {
  expect(() => createRunner({ timeoutMs: NaN })).toThrow(TypeError);
  const runner = createRunner();
  await expect(runner.run({ prompt: 'hello', args: ['--output-format=text'] })).rejects.toThrow(/format/);
  await expect(runner.run({ prompt: 'hello', timeoutMs: -1 })).rejects.toThrow(TypeError);
});
