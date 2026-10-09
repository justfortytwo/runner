import { spawn as nodeSpawn } from 'node:child_process';
import { command, configuration, duration, validatePrompt, type RunnerOptions, type RunOptions, type RuntimeOptions } from './command.js';
import { RunnerSpawnError } from './errors.js';
import { boundOutputDrain, shutdown } from './lifecycle.js';
import { RunnerSession } from './session.js';
export type { RunnerOptions, RunOptions, RuntimeOptions } from './command.js';
export interface RunResult { ok: boolean; text: string; raw: unknown }
export function resultFrom(raw: unknown, success = true): RunResult {
  const value = raw as { result?: unknown; is_error?: unknown } | null;
  return { ok: success && !value?.is_error, text: typeof value?.result === 'string' ? value.result : '', raw };
}
export interface Runner {
  run(options: RunOptions): Promise<RunResult>;
  createSession(options?: RuntimeOptions): Promise<RunnerSession>;
}
export function createRunner(opts: RunnerOptions = {}): Runner {
  const defaults = { ...opts, env: { ...opts.env }, args: [...(opts.args ?? [])] };
  const spawn = opts.spawn ?? nodeSpawn;
  const bin = opts.bin ?? process.env['CLAUDE_BIN'] ?? 'claude';
  const defaultTimeout = opts.timeoutMs;
  duration(defaultTimeout, 'timeoutMs');
  const run = async (options: RunOptions): Promise<RunResult> => {
    validatePrompt(options.prompt);
    const config = configuration(defaults, options);
    const args = command(config, false, options.prompt);
    const timeoutMs = options.timeoutMs ?? defaultTimeout;
    duration(timeoutMs, 'timeoutMs');
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(bin, args, { cwd: config.cwd, env: config.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (cause) { reject(new RunnerSpawnError(cause)); return; }
      boundOutputDrain(child, config.shutdownGraceMs ?? 1000);
      let out = '', timedOut = false;
      let stopShutdown: (() => void) | undefined;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true; stopShutdown = shutdown(child, config.shutdownGraceMs ?? 1000, false);
      }, timeoutMs);
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (data: string | Buffer) => { out += data.toString(); });
      child.stderr?.resume?.();
      child.stdin?.on('error', () => {});
      child.stdin?.end();
      child.once('error', cause => { clearTimeout(timer); stopShutdown?.(); reject(new RunnerSpawnError(cause)); });
      child.once('close', code => {
        clearTimeout(timer); stopShutdown?.();
        if (timedOut) { resolve({ ok: false, text: '', raw: null }); return; }
        try { resolve(resultFrom(JSON.parse(out), code === 0)); }
        catch { resolve({ ok: false, text: out, raw: null }); }
      });
    });
  };
  return {
    run,
    createSession: (options: RuntimeOptions = {}) => RunnerSession.start(bin, spawn, configuration(defaults, options)),
  };
}
