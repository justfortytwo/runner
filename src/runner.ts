import { spawn as nodeSpawn } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  text: string;
  raw: unknown;
}

export interface RunnerOptions {
  spawn?: typeof nodeSpawn;
  bin?: string;
  timeoutMs?: number;
  cwd?: string;
}

export function createRunner(opts: RunnerOptions = {}) {
  const spawn = opts.spawn ?? nodeSpawn;
  const bin = opts.bin ?? process.env['CLAUDE_BIN'] ?? 'claude';
  // `||` (not `??`) so an empty-string env var falls back to 300; `Number('')`
  // is 0, which would otherwise produce a 0ms timeout that fires immediately.
  const envSeconds = Number(process.env['FORTYTWO_TURN_TIMEOUT'] || 300);
  // Keep `opts.timeoutMs ??` so an explicit `0` from a caller is still respected.
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envSeconds) ? envSeconds * 1000 : 300_000);

  return (prompt: string, extraArgs: string[] = []): Promise<RunResult> =>
    new Promise((resolve) => {
      const child = spawn(bin, ['-p', '--output-format', 'json', ...extraArgs, prompt], {
        cwd: opts.cwd,
      });
      let out = '';
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore kill errors
        }
        resolve({ ok: false, text: '', raw: null });
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.on('close', (code: number | null) => {
        clearTimeout(t);
        try {
          const j = JSON.parse(out) as Record<string, unknown>;
          resolve({
            ok: code === 0 && !j['is_error'],
            text: typeof j['result'] === 'string' ? j['result'] : '',
            raw: j,
          });
        } catch {
          resolve({ ok: false, text: out, raw: null });
        }
      });
    });
}
