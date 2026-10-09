import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRunner } from '../src/runner.js';
const bin = resolve('test/fixtures/claude.mjs');
const sessions: any[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); });
async function start(options = {}) {
  const session = await createRunner({ bin }).createSession(options);
  sessions.push(session);
  return session;
}
function next(session: any, name: string): Promise<any> {
  return new Promise(resolve => session.once(name, resolve));
}
describe('runtime', () => {
  it('exposes a plain object API for one-shot jobs and sessions', async () => {
    const runner = createRunner({ bin });
    expect(typeof runner).toBe('object');
    expect(typeof runner.createSession).toBe('function');
    expect((await runner.run({ prompt: 'world' })).text).toBe('world');
  });
  it('starts, captures identity, environment, cwd and resume arguments', async () => {
    const env = Object.freeze({ TEST_MARKER: 'provider' });
    const s = await start({ env, cwd: process.cwd(), args: ['--model', 'custom'], resumeSessionId: 'resume-id' });
    const raw = await next(s, 'raw');
    expect(raw.session_id).toBe('resume-id');
    expect(s.sessionId).toBe('resume-id');
    expect(raw.marker).toBe('provider');
    expect(raw.cwd).toBe(process.cwd());
    expect(raw.args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'custom', '--resume', 'resume-id']);
    expect(s.state).toBe('ready');
  });
  it('serializes concurrent turns and streams normalized events', async () => {
    const s = await start();
    const results: string[] = [], assistants: string[] = [];
    s.on('result', (r: any) => results.push(r.text));
    s.on('assistant', (m: any) => assistants.push(m.text));
    const done = new Promise<void>(resolve => s.on('result', () => { if (results.length === 3) resolve(); }));
    await Promise.all(['one', 'two\n三', 'three'].map(text => s.send(text)));
    await done;
    expect(results).toEqual(['one', 'two\n三', 'three']);
    expect(assistants).toEqual(results);
    expect(s.lastActivityAt).toBeGreaterThanOrEqual(s.startedAt);
  });
  it('reports malformed lines without losing subsequent events', async () => {
    const s = await start();
    const error = next(s, 'error'), result = next(s, 'result');
    await s.send('bad');
    expect((await error).line).toBe('not json');
    expect((await result).text).toBe('bad');
  });
  it('detects failure exit and rejects subsequent writes', async () => {
    const s = await start();
    const exit = next(s, 'exit');
    await s.send('exit');
    expect((await exit).code).toBe(2);
    expect(s.state).toBe('failed');
    await expect(s.send('late')).rejects.toThrow(/closed/i);
  });
  it('closes gracefully and idempotently', async () => {
    const s = await start();
    await s.send('hello');
    await Promise.all([s.close(), s.close()]);
    expect(s.state).toBe('closed');
    expect(s.exitCode).toBe(0);
    await expect(s.send('late')).rejects.toThrow(/closed/i);
  });
  it('force kills an uncooperative process', async () => {
    const s = await start({ shutdownGraceMs: 30 });
    const result = next(s, 'result');
    await s.send('stubborn'); await result;
    await s.close();
    expect(s.exitSignal).toBe('SIGKILL');
  });
  it('isolates concurrent sessions', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    const ar = next(a, 'result'), br = next(b, 'result');
    await Promise.all([a.send('A'), b.send('B')]);
    expect((await ar).text).toBe('A'); expect((await br).text).toBe('B');
    expect(a.sessionId).not.toBe(b.sessionId);
  });
  it('rejects invalid input and spawn failures', async () => {
    const s = await start();
    await expect(s.send('')).rejects.toThrow();
    await expect(s.send(null)).rejects.toThrow();
    await expect(createRunner({ bin: '/missing/claude' }).createSession()).rejects.toThrow(/spawn/i);
  });
});

describe('transport edge cases', () => {
  it('parses fragmented UTF-8, CRLF, multiple lines and a final unterminated line', async () => {
    const s = await start();
    const texts: string[] = [];
    s.on('result', (r: any) => texts.push(r.text));
    const exit = next(s, 'exit');
    await s.send('fragment');
    await exit;
    expect(texts).toEqual(['héllo 三', 'tail']);
  });
  it('reports stderr without failing and preserves unknown raw events', async () => {
    const s = await start();
    const stderr = next(s, 'stderr'), result = next(s, 'result');
    const events: any[] = [];
    s.on('event', (event: any) => events.push(event));
    await s.send('hello');
    expect(await stderr).toContain('diagnostic');
    expect((await result).ok).toBe(true);
    expect(events.some(e => e.type === 'raw')).toBe(true);
    expect(s.state).toBe('ready');
  });
  it('handles closed stdin and rejects queued writes without unhandled errors', async () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })); } });
    child.kill = () => { child.emit('exit', 0, null); child.emit('close', 0, null); return true; };
    const s = await createRunner({ spawn: (() => { queueMicrotask(() => child.emit('spawn')); return child; }) as any }).createSession({ shutdownGraceMs: 1 });
    sessions.push(s);
    const writes = await Promise.allSettled([s.send('x'.repeat(2_000_000)), s.send('queued')]);
    expect(writes.every(r => r.status === 'rejected')).toBe(true);
    expect(s.state).toBe('failed');
    await s.close();
  });
  it('rejects new and queued turns as soon as close begins', async () => {
    const s = await start();
    const pending = s.send('queued');
    const closed = s.close();
    await expect(pending).rejects.toThrow(/closed/i);
    await expect(s.send('late')).rejects.toThrow(/closed/i);
    await closed;
  });
  it('one-shot timeout waits for termination; spawn failures reject', async () => {
    const runner = createRunner({ bin });
    expect((await runner.run({ prompt: 'hang', timeoutMs: 100, shutdownGraceMs: 20 })).ok).toBe(false);
    await expect(createRunner({ bin: '/missing/claude' }).run({ prompt: 'x' })).rejects.toThrow(/spawn/i);
  });
});

it('bounds output drain after parent exit when descendants retain pipes', async () => {
  const s = await start({ shutdownGraceMs: 20 });
  const exit = next(s, 'exit');
  const started = Date.now();
  await s.send('inherited-pipes');
  await exit;
  expect(Date.now() - started).toBeLessThan(700);
  expect(s.exitCode).toBe(0);
});


it('uses explicit timeout options rather than legacy application environment', async () => {
  vi.stubEnv('FORTYTWO_TURN_TIMEOUT', '0');
  try {
    expect((await createRunner({ bin }).run({ prompt: 'hello' })).ok).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
