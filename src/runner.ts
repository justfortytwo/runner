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
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env['FORTYTWO_TURN_TIMEOUT'] ?? 300) * 1000;

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
      child.on('close', (code: number) => {
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
