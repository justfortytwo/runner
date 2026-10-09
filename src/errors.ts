export class RunnerSpawnError extends Error {
  override name = 'RunnerSpawnError';
  constructor(cause: unknown) { super('Failed to spawn Claude Code', { cause }); }
}
export class RunnerClosedError extends Error {
  override name = 'RunnerClosedError';
  constructor(cause?: unknown) { super('Session input is closed', { cause }); }
}
export class RunnerProtocolError extends Error {
  override name = 'RunnerProtocolError';
  constructor(readonly line: string, cause: unknown) { super('Malformed Claude JSONL output', { cause }); }
}
