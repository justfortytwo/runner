import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import type { ChildProcess, spawn } from 'node:child_process';
import { command, validatePrompt, type RuntimeOptions } from './command.js';
import { RunnerClosedError, RunnerProtocolError, RunnerSpawnError } from './errors.js';
import { boundOutputDrain, shutdown } from './lifecycle.js';
import { resultFrom, type RunResult } from './runner.js';

export type SessionState = 'starting' | 'ready' | 'running' | 'closed' | 'failed';
export type RunnerEvent =
  | { type: 'raw'; data: unknown }
  | { type: 'assistant'; text: string; raw: unknown }
  | { type: 'result'; result: RunResult; raw: unknown }
  | { type: 'stderr'; text: string }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; error: Error };
type AssistantEvent = Extract<RunnerEvent, { type: 'assistant' }>;
type ExitEvent = Extract<RunnerEvent, { type: 'exit' }>;
interface SessionEvents {
  event: [RunnerEvent]; raw: [unknown]; assistant: [AssistantEvent];
  result: [RunResult]; stderr: [string]; exit: [ExitEvent]; error: [Error];
}

export class RunnerSession extends EventEmitter<SessionEvents> {
  private currentState: SessionState = 'starting';
  private id?: string;
  private activity = Date.now();
  readonly startedAt = this.activity;
  private code: number | null = null;
  private signal: string | null = null;
  private closing = false;
  private exited = false;
  private finished = false;
  private pendingTurns = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly reader: Interface;
  private readonly completion: Promise<void>;
  private complete!: () => void;
  private stopShutdown?: () => void;
  private inputError?: Error;
  private readonly pendingWrites = new Set<(error: Error) => void>();
  readonly config: Readonly<RuntimeOptions>;

  get state(): SessionState { return this.currentState; }
  get sessionId(): string | undefined { return this.id; }
  get lastActivityAt(): number { return this.activity; }
  get exitCode(): number | null { return this.code; }
  get exitSignal(): string | null { return this.signal; }

  private constructor(private readonly child: ChildProcess, options: RuntimeOptions) {
    super();
    this.config = Object.freeze({ ...options, env: Object.freeze({ ...options.env }), args: Object.freeze([...(options.args ?? [])]) });
    this.id = options.resumeSessionId;
    this.completion = new Promise(resolve => { this.complete = resolve; });
    boundOutputDrain(child, options.shutdownGraceMs ?? 1000);
    this.reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.reader.on('line', this.onLine);
    child.stdout!.on('data', this.onActivity);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', this.onStderr);
    child.stdin!.on('error', this.onInputError);
    child.stdin!.on('close', this.onInputClose);
    child.on('error', this.onProcessError);
    child.once('exit', this.onProcessExit);
    child.once('close', this.onClose);
  }

  static async start(binary: string, spawnChild: typeof spawn, options: RuntimeOptions): Promise<RunnerSession> {
    const args = command(options, true);
    let child: ChildProcess;
    try { child = spawnChild(binary, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (cause) { throw new RunnerSpawnError(cause); }
    const session = new RunnerSession(child, options);
    return new Promise((resolve, reject) => {
      const onError = (cause: Error) => { child.off('spawn', onSpawn); reject(new RunnerSpawnError(cause)); };
      const onSpawn = () => { child.off('error', onError); session.currentState = 'ready'; resolve(session); };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  /** Resolves after the complete JSONL turn has been written, not after its result. */
  async send(text: string): Promise<void> {
    validatePrompt(text);
    this.assertWritable();
    const write = this.writes.then(() => new Promise<void>((resolve, reject) => {
      try { this.assertWritable(); } catch (error) { reject(error); return; }
      const line = JSON.stringify({ type: 'user', session_id: this.id ?? '', message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n';
      const fail = (error: Error) => { this.pendingWrites.delete(fail); reject(error); };
      this.pendingWrites.add(fail);
      this.pendingTurns++;
      this.currentState = 'running';
      this.activity = Date.now();
      try {
        this.child.stdin!.write(line, error => {
          this.pendingWrites.delete(fail);
          if (error) { this.onInputError(error); reject(new RunnerClosedError(error)); } else resolve();
        });
      } catch (error) { this.onInputError(error instanceof Error ? error : new Error(String(error))); fail(new RunnerClosedError(error)); }
    }));
    this.writes = write.catch(() => {});
    return write;
  }

  close(): Promise<void> {
    if (!this.finished && !this.closing) {
      this.closing = true;
      this.rejectWrites(new RunnerClosedError());
      this.stopShutdown = shutdown(this.child, this.config.shutdownGraceMs ?? 1000, true);
    }
    return this.completion;
  }

  private assertWritable(): void {
    if (this.closing || this.exited || this.finished || this.inputError || this.child.stdin?.destroyed || this.child.stdin?.writableEnded) {
      throw new RunnerClosedError(this.inputError);
    }
  }
  private rejectWrites(error: Error): void {
    for (const reject of this.pendingWrites) reject(error);
  }
  private publish(event: RunnerEvent): void {
    this.emit('event', event);
    switch (event.type) {
      case 'raw': this.emit('raw', event.data); break;
      case 'assistant': this.emit('assistant', event); break;
      case 'result': this.emit('result', event.result); break;
      case 'stderr': this.emit('stderr', event.text); break;
      case 'exit': this.emit('exit', event); break;
      case 'error': if (this.listenerCount('error')) this.emit('error', event.error); break;
    }
  }
  private onLine = (line: string): void => {
    this.activity = Date.now();
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch (cause) {
      this.publish({ type: 'raw', data: line });
      this.publish({ type: 'error', error: new RunnerProtocolError(line, cause) });
      return;
    }
    const event = raw as Record<string, any> | null;
    if (event && typeof event.session_id === 'string') this.id = event.session_id;
    if (event?.type === 'result') {
      this.pendingTurns = Math.max(0, this.pendingTurns - 1);
      if (!this.exited && !this.inputError) this.currentState = this.pendingTurns ? 'running' : 'ready';
    }
    this.publish({ type: 'raw', data: raw });
    if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      const text = event.message.content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('');
      if (text) this.publish({ type: 'assistant', text, raw });
    }
    if (event?.type === 'result') this.publish({ type: 'result', result: resultFrom(raw), raw });
  };
  private onActivity = (): void => { this.activity = Date.now(); };
  private onStderr = (text: string): void => {
    this.activity = Date.now(); this.publish({ type: 'stderr', text });
  };
  private onInputError = (cause: Error): void => {
    if (this.inputError) return;
    this.inputError = new RunnerClosedError(cause);
    this.pendingTurns = 0;
    if (!this.closing && !this.exited) this.currentState = 'failed';
    this.rejectWrites(this.inputError);
    this.publish({ type: 'error', error: this.inputError });
  };
  private onInputClose = (): void => {
    if (!this.closing && !this.exited && !this.inputError) this.onInputError(new RunnerClosedError());
    this.inputError ??= new RunnerClosedError();
    this.rejectWrites(this.inputError);
  };
  private onProcessError = (cause: Error): void => {
    this.currentState = 'failed';
    this.publish({ type: 'error', error: new RunnerSpawnError(cause) });
  };
  private onProcessExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.exited = true; this.code = code; this.signal = signal;
    this.currentState = this.closing || code === 0 ? 'closed' : 'failed';
    this.rejectWrites(new RunnerClosedError());
  };
  private onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.onProcessExit(code, signal);
    this.finished = true;
    this.activity = Date.now();
    this.stopShutdown?.();
    this.reader.close(); this.reader.off('line', this.onLine);
    this.child.stdout?.off('data', this.onActivity);
    this.child.stderr?.off('data', this.onStderr);
    this.child.stdin?.off('error', this.onInputError);
    this.child.stdin?.off('close', this.onInputClose);
    this.child.off('error', this.onProcessError);
    this.child.off('exit', this.onProcessExit);
    this.complete();
    this.publish({ type: 'exit', code, signal });
  };
}
