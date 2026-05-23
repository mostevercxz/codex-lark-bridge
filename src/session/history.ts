import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface SessionSummary {
  sessionId: string;
  mtime: number;
  preview: string;
  lineCount: number;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

/** Return the most recent `limit` jsonl sessions for the given cwd, newest first. */
export async function listRecentSessions(
  cwd: string,
  limit = 5,
  agentId = 'claude',
): Promise<SessionSummary[]> {
  if (agentId === 'codex') return listRecentCodexSessions(cwd, limit);
  return listRecentClaudeSessions(cwd, limit);
}

async function listRecentClaudeSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  const dir = claudeProjectDir(cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const jsonls = files.filter((f) => f.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      const path = join(dir, f);
      try {
        const st = await stat(path);
        return { file: f, path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter((x): x is { file: string; path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const sessionId = entry.file.replace(/\.jsonl$/, '');
      const { preview, lineCount } = await summarize(entry.path);
      return { sessionId, mtime: entry.mtime, preview, lineCount };
    }),
  );
}

async function listRecentCodexSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  const root = join(homedir(), '.codex', 'sessions');
  const files = (await walkJsonl(root)).filter((f) => f.includes('/rollout-'));
  const withStats = await Promise.all(
    files.map(async (path) => {
      try {
        const st = await stat(path);
        return { path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  const out: SessionSummary[] = [];
  for (const entry of sorted) {
    const summary = await summarizeCodex(entry.path, cwd, entry.mtime);
    if (!summary) continue;
    out.push(summary);
    if (out.length >= limit) break;
  }
  return out;
}

async function walkJsonl(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walkJsonl(path);
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
    }),
  );
  return nested.flat();
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (obj.type === 'user' && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview = text.slice(0, 80);
          }
        } catch {
          /* malformed line */
        }
      }
      // reading the whole file is fine — sessions are usually under 10k lines
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text.trim();
      }
    }
  }
  return '';
}

async function summarizeCodex(
  path: string,
  cwd: string,
  mtime: number,
): Promise<SessionSummary | undefined> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let sessionId = '';
  let sessionCwd = '';
  let preview = '';
  let lineCount = 0;

  try {
    for await (const line of rl) {
      lineCount++;
      try {
        const obj = JSON.parse(line) as CodexSessionLine;
        if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
          const payload = obj.payload as { id?: unknown; cwd?: unknown };
          sessionId = typeof payload?.id === 'string' ? payload.id : sessionId;
          sessionCwd = typeof payload?.cwd === 'string' ? payload.cwd : sessionCwd;
          if (sessionCwd && sessionCwd !== cwd) return undefined;
        } else if (!preview) {
          preview = extractCodexUserText(obj);
        }
      } catch {
        /* malformed line */
      }
      if (preview && sessionId && sessionCwd) break;
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!sessionId || sessionCwd !== cwd) return undefined;
  return {
    sessionId,
    mtime,
    preview: preview || '(空会话)',
    lineCount,
  };
}

interface CodexSessionLine {
  type?: string;
  payload?: unknown;
}

function extractCodexUserText(obj: CodexSessionLine): string {
  const payload = obj.payload;
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    message?: unknown;
  };
  if (obj.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
    return cleanCodexPreview(p.message);
  }
  if (obj.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') return '';
  return cleanCodexPreview(extractCodexContentText(p.content));
}

function extractCodexContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'input_text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

function cleanCodexPreview(text: string): string {
  let out = text.trim();
  const marker = '\n---\n\n';
  const idx = out.indexOf(marker);
  if (
    (out.includes('lark-codex-bridge runtime notes') ||
      out.includes('lark-channel-bridge runtime notes')) &&
    idx !== -1
  ) {
    out = out.slice(idx + marker.length).trim();
  }
  out = out.replace(/<bridge_context>[\s\S]*?<\/bridge_context>\s*/g, '').trim();
  if (out.startsWith('<environment_context>')) return '';
  return out.slice(0, 80);
}

/** Format a relative time like "3 小时前", "昨天", "3 天前". */
export function formatRelTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  return `${mo} 个月前`;
}
