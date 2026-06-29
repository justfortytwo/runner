import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRunner } from '../src/runner.js';

// Fake child process: emits canned stdout then closes with code 0.
function fakeSpawn(stdout: string, code = 0) {
  return () => {
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
});
