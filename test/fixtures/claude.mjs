#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const session_id = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : `session-${process.pid}`;
if (!args.includes('stream-json')) {
  if (args.at(-1) === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  else emit({ result: args.at(-1), is_error: false });
} else {
  emit({ type: 'system', subtype: 'init', session_id, args, marker: process.env.TEST_MARKER, cwd: process.cwd() });
  const lines = createInterface({ input: process.stdin });
  // Mirrors Claude steering: inputs queued during a turn join it and share one result.
  const held = [];
  const replay = text => { if (args.includes('--replay-user-messages')) emit({ type: 'user', isReplay: true, message: { role: 'user', content: text }, session_id }); };
  lines.on('line', line => {
    const input = JSON.parse(line);
    const text = input.message.content;
    if (text === 'hold') { held.push(text); return; }
    if (held.length) {
      for (const queued of held.splice(0)) replay(queued);
      replay(text);
      emit({ type: 'result', result: 'steered', is_error: false, session_id });
      return;
    }
    if (text === 'fragment') {
      const bytes = Buffer.from(JSON.stringify({ type: 'result', result: 'héllo 三' }) + '\r\n' + JSON.stringify({ type: 'result', result: 'tail' }));
      let i = 0;
      const timer = setInterval(() => {
        if (i < bytes.length) process.stdout.write(bytes.subarray(i, ++i));
        else { clearInterval(timer); process.exit(0); }
      }, 1);
      return;
    }
    if (text === 'inherited-pipes') {
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 900)'], { stdio: ['ignore', process.stdout, process.stderr] });
      process.exit(0);
    }
    if (text === 'exit') process.exit(2);
    if (text === 'bad') process.stdout.write('not json\n');
    if (text === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
    process.stderr.write('diagnostic\n');
    replay(text);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id });
    emit({ type: 'result', result: text, is_error: false, session_id });
  });
}
