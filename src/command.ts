import type { spawn } from 'node:child_process';

export interface RuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  args?: readonly string[];
  resumeSessionId?: string;
  /** Grace period for EOF and then SIGTERM, in milliseconds. Default 1000. */
  shutdownGraceMs?: number;
}
export interface RunnerOptions extends RuntimeOptions {
  spawn?: typeof spawn;
  bin?: string;
  /** Explicit one-shot wall-clock limit. Undefined means no limit. */
  timeoutMs?: number;
}
export interface RunOptions extends RuntimeOptions {
  prompt: string;
  timeoutMs?: number;
}
export function duration(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 2_147_483_647)) {
    throw new TypeError(`${name} must be a finite nonnegative timer duration`);
  }
}
export function configuration(defaults: RunnerOptions, options: RuntimeOptions): RuntimeOptions {
  const config: RuntimeOptions = {
    cwd: options.cwd ?? defaults.cwd,
    env: { ...process.env, ...defaults.env, ...options.env },
    args: [...(defaults.args ?? []), ...(options.args ?? [])],
    resumeSessionId: options.resumeSessionId ?? defaults.resumeSessionId,
    shutdownGraceMs: options.shutdownGraceMs ?? defaults.shutdownGraceMs,
  };
  duration(config.shutdownGraceMs, 'shutdownGraceMs');
  return config;
}
export function command(options: RuntimeOptions, streaming: boolean, prompt?: string): string[] {
  const args = options.args ?? [];
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new TypeError('Arguments must be strings without NUL');
    if (/^--(?:input-format|output-format)(?:=|$)/.test(arg)) {
      throw new TypeError('The runner owns input-format and output-format');
    }
  }
  if (options.resumeSessionId !== undefined && (!options.resumeSessionId.trim() || options.resumeSessionId.includes('\0'))) {
    throw new TypeError('resumeSessionId must be nonempty and contain no NUL');
  }
  return ['-p', ...(streaming ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages'] : ['--output-format', 'json']),
    ...args, ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
    ...(prompt === undefined ? [] : [prompt])];
}
export function validatePrompt(prompt: string): void {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
    throw new TypeError('Prompt must be a nonempty string without NUL');
  }
}
