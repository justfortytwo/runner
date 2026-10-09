import type { ChildProcess } from 'node:child_process';

/** Bound pipe draining after the owned parent exits; descendants are not owned. */
export function boundOutputDrain(child: ChildProcess, graceMs: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExit = () => {
    timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }, graceMs);
  };
  child.once('exit', onExit);
  child.once('close', () => { clearTimeout(timer); child.off('exit', onExit); });
}

/** Caller clears timers on close. Never detaches or resolves before child close. */
export function shutdown(child: ChildProcess, graceMs: number, graceful: boolean): () => void {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.kill('SIGTERM');
  };
  const termTimer = graceful ? setTimeout(terminate, graceMs) : undefined;
  if (graceful) child.stdin?.end();
  else terminate();
  return () => { clearTimeout(termTimer); clearTimeout(killTimer); };
}
