import { spawn } from 'node:child_process';
import { boundedCommandText, redactCommandOutput } from './command-output';

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  truncated: boolean;
  error: { code: string; message: string } | null;
}

/** Internal limits may be lowered by tests; tool arguments cannot raise them. */
export async function executeCommand(command: string, args: string[], cwd: string, signal?: AbortSignal,
  limits: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<CommandResult> {
  const started = performance.now();
  args = [...args];
  const timeoutMs = Math.min(limits.timeoutMs ?? 120000, 120000);
  const maxBuffer = Math.min(limits.maxBuffer ?? 1024 * 1024, 1024 * 1024);
  const output: CommandResult = {
    command, args, cwd, exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0,
    timedOut: false, cancelled: signal?.aborted ?? false, outputLimitExceeded: false, truncated: false, error: null,
  };
  if (!output.cancelled) await new Promise<void>(resolve => {
    const streams = { stdout: { chunks: [] as Buffer[], size: 0, incomplete: false }, stderr: { chunks: [] as Buffer[], size: 0, incomplete: false } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let child: ReturnType<typeof spawn>;
    const failed = (error: NodeJS.ErrnoException) => {
      const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
      // Node's error.message can echo raw arguments and secret output.
      output.error = { code, message: `Unable to run command (${code}). Check the executable and working directory.` };
    };
    try {
      child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { failed(error as NodeJS.ErrnoException); resolve(); return; }
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill();
      // Bound shutdown when the child ignores SIGTERM or descendants hold pipes open.
      cleanupTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1000);
    };
    const cancel = () => { output.cancelled = true; stop(); };
    for (const name of ['stdout', 'stderr'] as const) child[name]?.on('data', (chunk: Buffer) => {
      const stream = streams[name];
      const remaining = maxBuffer - stream.size;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        stream.chunks.push(kept);
        stream.size += kept.length;
      }
      if (chunk.length > remaining) {
        stream.incomplete = true;
        output.outputLimitExceeded = true;
        output.truncated = true;
        stop();
      }
    });
    child.on('error', failed);
    child.on('close', (code, terminatingSignal) => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', cancel);
      output.exitCode = output.error ? null : code;
      output.signal = terminatingSignal;
      for (const name of ['stdout', 'stderr'] as const) {
        const stream = streams[name];
        let text = Buffer.concat(stream.chunks, stream.size).toString('utf8');
        // A raw capture boundary can cut a credential marker. Omit that line
        // before redaction instead of displaying an orphaned secret value.
        if (stream.incomplete) text = text.slice(0, text.lastIndexOf('\n') + 1) + '\n... output limit; incomplete line omitted ...';
        output[name] = text;
      }
      resolve();
    });
    timer = setTimeout(() => { output.timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  output.durationMs = Math.round(performance.now() - started);
  const clean = (text: string, budget: number) => {
    const bounded = boundedCommandText(redactCommandOutput(text), budget);
    output.truncated ||= bounded.truncated;
    return bounded.text;
  };
  output.command = clean(command, 512);
  output.cwd = clean(cwd, 2048);
  const joined = args.join(' ');
  if (redactCommandOutput(joined) !== joined) output.args = ['[sensitive arguments redacted]'];
  else if (JSON.stringify(args).length > 2048) { output.args = ['[arguments truncated]']; output.truncated = true; }
  output.stdout = clean(output.stdout, 10000);
  output.stderr = clean(output.stderr, 10000);
  return output;
}

export function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.signal && !result.error && !result.timedOut && !result.cancelled && !result.outputLimitExceeded;
}
