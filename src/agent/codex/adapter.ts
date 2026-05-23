import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateEvent } from './json';

export interface CodexAdapterOptions {
  binary?: string;
}

type CodexChild = ChildProcessByStdio<Writable, Readable, Readable>;

const BRIDGE_PROMPT = `# lark-codex-bridge runtime notes

You are running inside lark-codex-bridge, which forwards Feishu/Lark messages to a local coding agent CLI.

Each user message may begin with invisible metadata blocks:
- <bridge_context> includes chat_id, chat_type, sender_id, sender_name, and optional thread_id.
- <quoted_message> contains the message the user replied to.
- <interactive_card> contains the full Feishu/Lark interactive card JSON.

Use these blocks as context, but do not quote their XML-like tags back to the user.

When sending an interactive Feishu/Lark card that should call back into this same session, use CardKit 2.0 via lark-cli and include "__claude_cb": true in the button callback value. The bridge will return the click payload as a "[card-click] {...}" user message.

For "lark-cli auth login", only start OAuth from p2p chats. In group/topic chats, tell the user to DM the bot. Use the two-stage device flow: first "lark-cli auth login --no-wait --json", send the verification_url plainly, then run "lark-cli auth login --device-code <code>" in the foreground until it completes.`;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = this.buildArgs(opts);
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CODEX_BRIDGE: '1', LARK_CHANNEL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      agent: this.id,
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { agent: this.id, line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.stdin.on('error', () => {
      /* The process may fail before it consumes stdin; surface the spawn/exit error instead. */
    });
    child.stdin.end(buildPrompt(opts.prompt));
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: this.id, pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', {
          agent: 'codex',
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
        });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                agent: 'codex',
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        // Codex can spend a few seconds after turn.completed cleaning up MCP
        // children. Give it room so successful turns don't look interrupted.
        const effectiveTimeoutMs = Math.max(timeoutMs, 8_000);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, effectiveTimeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }

  private buildArgs(opts: AgentRunOptions): string[] {
    const common = ['--json', '--skip-git-repo-check'];
    if (opts.model) common.push('-m', opts.model);
    common.push(...permissionArgs(opts.permissionMode));

    if (opts.sessionId) {
      return ['exec', 'resume', ...common, opts.sessionId, '-'];
    }

    const args = ['exec', ...common];
    if (opts.cwd) args.push('-C', opts.cwd);
    args.push('-');
    return args;
  }
}

function permissionArgs(mode: AgentRunOptions['permissionMode']): string[] {
  if (mode === 'plan') return ['--ask-for-approval', 'never', '--sandbox', 'read-only'];
  if (mode === 'default' || mode === 'acceptEdits') {
    return ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'];
  }
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function buildPrompt(prompt: string): string {
  return `${BRIDGE_PROMPT}

---

${prompt}`;
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
