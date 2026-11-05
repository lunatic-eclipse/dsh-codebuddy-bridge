// SPDX-License-Identifier: MIT
/**
 * CodeBuddy bridge.
 *
 * Lets a DSH agent talk to the CodeBuddy CLI installed on this machine (also
 * bundled inside the WorkBuddy desktop app). One long-lived engine process per
 * DSH session is driven over the engine's stream-json protocol, so the two
 * agents can review each other's work turn by turn.
 *
 * Everything the engine reports is returned as ordinary tool content, so the
 * DSH session log stays the single source of truth.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';

export const name = 'codebuddy-bridge';
export const inject = ['tools', 'webServer'];

/** Candidate engine entry points, most specific first. */
const CLI_CANDIDATES = [
  process.env.WORKBUDDY_CLI_PATH,
  join(
    process.env.LOCALAPPDATA ?? '',
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar.unpacked',
    'cli',
    'bin',
    'codebuddy',
  ),
].filter((value) => typeof value === 'string' && value.length > 0);

/** WorkBuddy product profile, needed when the engine entry point is a plain npm CLI. */
const PRODUCT_CANDIDATES = [
  process.env.WORKBUDDY_PRODUCT_CONFIG,
  join(
    process.env.LOCALAPPDATA ?? '',
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar.unpacked',
    'cli',
    'product.json',
  ),
].filter((value) => typeof value === 'string' && value.length > 0);

const FIRST_OK = (candidates) => candidates.find((candidate) => existsSync(candidate));

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_IDLE_MS = 60 * 60 * 1000;
const MAX_STDERR = 8 * 1024;

/** Tools hidden from an agent while collaboration mode is off for its session. */
const GATED_TOOLS = ['codebuddy_ask', 'workbuddy_relay', 'workbuddy_task', 'workbuddy_dispatch'];

/** Trim an engine tool payload down to something a human can approve. */
function summarizeToolInput(input, limit = 600) {
  if (input === undefined || input === null) return '';
  let text;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function describeAction(name, input) {
  const summary = summarizeToolInput(input, 200);
  if (name === 'Bash' || name === 'PowerShell') {
    let command = '';
    try {
      const parsed = typeof input === 'string' ? JSON.parse(input) : input;
      command = parsed?.command ?? parsed?.script ?? '';
    } catch {
      command = summary;
    }
    return `${name}: ${String(command).slice(0, 200)}`;
  }
  return summary ? `${name}: ${summary}` : name;
}

/** Root of the desktop app's own state, which holds readable session transcripts. */
const WORKBUDDY_HOME =
  process.env.WORKBUDDY_HOME?.trim() || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.workbuddy');
const TRANSCRIPTS_DIR = join(WORKBUDDY_HOME, 'projects');

/** Every readable desktop-app transcript, newest first. */
function listTranscripts() {
  const found = [];
  let projects;
  try {
    projects = readdirSync(TRANSCRIPTS_DIR, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(TRANSCRIPTS_DIR, project.name);
    let files;
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl') || file.name.includes('file-rollback')) continue;
      const path = join(dir, file.name);
      try {
        const stat = statSync(path);
        found.push({
          path,
          project: project.name,
          session: file.name.slice(0, -'.jsonl'.length),
          modified: stat.mtimeMs,
          bytes: stat.size,
        });
      } catch {
        /* unreadable entry */
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified);
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  return '';
}

/** Turn one transcript file into readable turns, newest last. */
function digestTranscript(entry, wantedTurns) {
  let raw;
  try {
    raw = readFileSync(entry.path, 'utf8');
  } catch (error) {
    throw new Error(`读取 WorkBuddy 会话记录失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const turns = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'message') continue;
    const role = event.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const blocks = Array.isArray(event.content) ? event.content : [];
    const texts = [];
    const tools = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' || block.type === 'tool_call') {
        tools.push(describeAction(String(block.name ?? ''), block.input ?? block.arguments));
        continue;
      }
      if (block.type === 'tool_result') continue;
      const text = blockText(block);
      if (!text.trim()) continue;
      if (text.startsWith('<system-reminder')) continue;
      texts.push(text);
    }
    if (texts.length === 0 && tools.length === 0) continue;
    const text = texts.join('\n').trim();
    if (role === 'user' && text.length === 0) continue;
    turns.push({ role, text, tools, time: typeof event.timestamp === 'number' ? event.timestamp : undefined });
  }
  return turns.slice(-Math.max(1, wantedTurns));
}

function formatTranscript(entry, turns) {
  const when = new Date(entry.modified).toLocaleString('zh-CN');
  const lines = [
    `WorkBuddy 会话 ${entry.session.slice(0, 8)}（项目 ${entry.project}，最后更新 ${when}）`,
    `记录文件：${entry.path}`,
  ];
  for (const turn of turns) {
    lines.push('');
    lines.push(turn.role === 'user' ? '【用户/上游】' : '【WorkBuddy】');
    if (turn.text) lines.push(turn.text);
    for (const tool of turn.tools) lines.push(`- 动作 ${tool}`);
  }
  return lines.join('\n');
}

/** WorkBuddy's written hand-back, when it has replaced the placeholder. */
function readOutbox(dir) {
  const path = join(dir, 'outbox.md');
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim() || text.includes('这里留给 WorkBuddy 填写')) return undefined;
    return { path, text: text.trim() };
  } catch {
    return undefined;
  }
}

function outboxDigest(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    /* state is a convenience only */
  }
}

/** Per-session collaboration switch, keyed by session id. */
function readModes(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'boolean'));
  } catch {
    return {};
  }
}

function writeModes(file, modes) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(modes, null, 2)}\n`, 'utf8');
  } catch {
    /* the switch still works in memory */
  }
}

function sendJson(res, status, payload) {
  try {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  } catch {
    /* the socket may already be gone */
  }
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

/** Where the CodeBuddy CLI keeps its own session transcripts. */
const CLI_PROJECTS_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codebuddy', 'projects');

function tagForTool(name) {
  const tool = String(name ?? '');
  if (tool === 'Glob' || tool === 'Grep') return '搜索';
  if (tool === 'Read' || tool === 'ReadImage' || tool === 'LS') return '读取';
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return '修改';
  if (tool === 'Bash' || tool === 'PowerShell') return '执行';
  if (tool === 'WebFetch' || tool === 'WebSearch') return '联网';
  return tool || '工具';
}

function findCliSessionFile(sessionId) {
  if (!sessionId) return undefined;
  try {
    for (const project of readdirSync(CLI_PROJECTS_DIR, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const candidate = join(CLI_PROJECTS_DIR, project.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no transcripts on this machine */
  }
  return undefined;
}

/** Turn one CLI transcript into the steps a human wants to see. */
function parseCliSession(sessionId) {
  const file = findCliSessionFile(sessionId);
  if (!file) return undefined;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const steps = [];
  let summary = '';
  let startedAt;
  let endedAt;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event?.timestamp === 'number') {
      if (!startedAt) startedAt = event.timestamp;
      endedAt = event.timestamp;
    }
    if (event?.type === 'function_call' && event.name) {
      const detail = String(event.providerData?.argumentsDisplayText ?? event.arguments ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      steps.push({ tag: tagForTool(event.name), text: detail ? `${event.name}  ${detail}` : event.name });
    } else if (event?.type === 'message' && event.role === 'assistant') {
      const text = (Array.isArray(event.content) ? event.content : [])
        .filter((block) => block?.type === 'output_text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text) summary = text.slice(0, 500);
    }
  }
  return {
    sessionId,
    file,
    steps: steps.slice(-40),
    stepCount: steps.length,
    summary,
    startedAt,
    endedAt,
  };
}


/**
 * Where the CLI keeps pre-images of edited files:
 *   ~/.codebuddy/file-history/<messageId>/<backupFileName>
 * Each backup is the content *before* that version, so comparing it with the
 * file on disk proves whether an edit really landed.
 */
const FILE_HISTORY_ROOT = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codebuddy', 'file-history');

/** Tools whose call means "this file was supposed to change". */
const MODIFY_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Loose candidate paths in a summary; existence/extension filters come after. */
const PATH_RE =
  /(?:[A-Za-z]:[\\/][^\s`'"“”‘’，。；、）)\]]+|[A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]{1,8})/gi;

/** Reads as "I changed something"; advice like "改：第 25 行…" must not match. */
const CLAIM_VERB_RE =
  /(?:已经?(?:修改|改动|更新|改写|重写|替换|写入|创建|新增|删除|移除|修复|补上|加上|落盘)|(?:修改|改动|更新|改写|重写|替换|写入|创建|新增|删除|移除|修复)了|改好|改完)/;
const NEGATION_RE = /(?:未(?:做|改|修改|改动|动)|没有(?:改|修改|改动|动)|没(?:改|修改|动)|无需|不用)/;

function readCliEvents(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') events.push(event);
    } catch {
      /* a torn line is skipped, not fatal */
    }
  }
  return events;
}

function parseToolArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toolFilePath(event) {
  const args = parseToolArguments(event?.arguments ?? event?.input);
  const raw =
    typeof args?.file_path === 'string'
      ? args.file_path
      : typeof args?.path === 'string'
        ? args.path
        : typeof args?.notebook_path === 'string'
          ? args.notebook_path
          : '';
  return raw.trim();
}

/** Timestamp inside [start, end], generous by a couple of seconds on each side. */
function withinWindow(ts, window) {
  if (!window) return true;
  if (typeof ts !== 'number') return true;
  return ts >= window.start && ts <= window.end;
}

function collectActions(events, window) {
  const actions = [];
  for (const event of events) {
    if (event?.type !== 'function_call') continue;
    const ts = typeof event.timestamp === 'number' ? event.timestamp : undefined;
    if (!withinWindow(ts, window)) continue;
    const name = String(event.name ?? '');
    actions.push({
      name,
      tag: tagForTool(name),
      ts,
      // Reads matter too: a review round proves it read the file it criticises.
      path: MODIFY_TOOLS.has(name) || name === 'Read' ? toolFilePath(event) : '',
      callId: typeof event.callId === 'string' ? event.callId : undefined,
      status: typeof event.status === 'string' ? event.status : undefined,
    });
  }
  return actions;
}

/** First snapshot of each path in the round = the state closest to its start. */
function collectBackups(events, window) {
  const index = new Map();
  for (const event of events) {
    if (event?.type !== 'file-history-snapshot') continue;
    if (!withinWindow(event.timestamp, window)) continue;
    const backups = event?.snapshot?.trackedFileBackups;
    if (!backups || typeof backups !== 'object') continue;
    for (const [rawPath, info] of Object.entries(backups)) {
      const key = rawPath.toLowerCase();
      const ts = typeof info?.backupTime === 'number' ? info.backupTime : event.timestamp;
      const previous = index.get(key);
      if (previous && !(typeof ts === 'number' && typeof previous.ts === 'number' && ts < previous.ts)) continue;
      index.set(key, {
        path: rawPath,
        ts,
        existedAtTrack: info?.existedAtTrack !== false,
        backupFileName: typeof info?.backupFileName === 'string' ? info.backupFileName : '',
        version: typeof info?.version === 'number' ? info.version : undefined,
      });
    }
  }
  return index;
}

function fileFacts(path) {
  try {
    const stat = statSync(path);
    let digest = '';
    try {
      digest = createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 12);
    } catch {
      /* unreadable but present */
    }
    return { exists: true, size: stat.size, mtime: stat.mtimeMs, digest };
  } catch {
    return { exists: false };
  }
}

function findBackupFile(backupFileName) {
  if (!backupFileName) return undefined;
  let dirs;
  try {
    dirs = readdirSync(FILE_HISTORY_ROOT, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = join(FILE_HISTORY_ROOT, dir.name, backupFileName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function displayPath(absolute, cwd) {
  if (!cwd) return absolute;
  const rel = relativePath(cwd, absolute);
  return rel && !rel.startsWith('..') ? rel : absolute;
}

function pathKey(absolute, cwd) {
  return displayPath(absolute, cwd).toLowerCase().replace(/\//g, '\\');
}

/** Paths named in a text block, resolved against the session cwd. */
function extractPaths(text, cwd) {
  const found = new Map();
  if (typeof text !== 'string' || !text) return found;
  for (const match of text.matchAll(PATH_RE)) {
    const raw = String(match[0])
      .replace(/[`'"“”‘’)\]）】，。；、]+$/g, '')
      .replace(/\\+$/, '');
    if (!raw || raw.length < 3) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) continue;
    const absolute = resolvePath(isAbsolute(raw) ? raw : resolvePath(cwd ?? process.cwd(), raw));
    const key = pathKey(absolute, cwd);
    if (!found.has(key)) found.set(key, { display: displayPath(absolute, cwd), absolute });
  }
  return found;
}

/** Split one "文件：a.md、b.md" line into resolved paths (spaces allowed). */
function pathsFromTokens(text, cwd) {
  const found = new Map();
  for (const token of String(text).split(/[、,，;；]/)) {
    const raw = token
      .trim()
      .replace(/^[`'"“”‘’（(\[]+/g, '')
      .replace(/[`'"“”‘’)\]）】，。；、]+$/g, '')
      .trim();
    if (!raw) continue;
    if (!/[\\/]/.test(raw) && !/\.[A-Za-z0-9]{1,8}$/.test(raw)) continue;
    const absolute = resolvePath(isAbsolute(raw) ? raw : resolvePath(cwd ?? process.cwd(), raw));
    const key = pathKey(absolute, cwd);
    if (!found.has(key)) found.set(key, { display: displayPath(absolute, cwd), absolute });
  }
  return found;
}

/**
 * Paths the summary claims it changed. Sentences without a "changed" verb, or
 * with a negation ("未改动"), are ignored — that is what keeps a review-only
 * round from being read as a pile of false claims.
 */
function extractClaims(summary, cwd) {
  const claims = new Map();
  if (typeof summary !== 'string' || !summary) return claims;
  for (const sentence of summary.split(/[。\n]/)) {
    if (!CLAIM_VERB_RE.test(sentence) || NEGATION_RE.test(sentence)) continue;
    for (const [key, item] of extractPaths(sentence, cwd)) {
      if (!claims.has(key)) claims.set(key, item);
    }
  }
  return claims;
}

/**
 * Files the task explicitly asked to look at, e.g. `文件：<path>` — inline or at
 * line start. Only those markers count: "don't touch index.js" must not turn
 * into an UNREAD.
 */
const FILE_MARKER_RE = /(?:文件|路径|path|files?)\s*[:：]\s*(.+)$/i;

function extractPromptPaths(prompt, cwd) {
  const found = new Map();
  if (typeof prompt !== 'string' || !prompt) return found;
  for (const line of prompt.split(/\r?\n/)) {
    const match = FILE_MARKER_RE.exec(line);
    if (!match) continue;
    for (const [key, item] of pathsFromTokens(match[1], cwd)) {
      if (!found.has(key)) found.set(key, item);
    }
  }
  return found;
}

/** Paths the summary says it read/checked, with advice ("建议看 X") excluded. */
const REVIEW_VERB_RE = /(审|读|看|检查|核对|review)/i;
const ADVICE_RE = /(建议|应该|可以|需要|待|如果|若|别|不要)/;

function extractMentionedPaths(summary, cwd) {
  const found = new Map();
  if (typeof summary !== 'string' || !summary) return found;
  for (const sentence of summary.split(/[。\n]/)) {
    if (!REVIEW_VERB_RE.test(sentence) || ADVICE_RE.test(sentence)) continue;
    for (const [key, item] of extractPaths(sentence, cwd)) {
      if (!found.has(key)) found.set(key, item);
    }
  }
  return found;
}

/** Files whose mtime moved during the round, walking the workspace only. */
function scanChangedFiles(cwd, window, limit = 2000) {
  const skip = new Set(['node_modules', '.git', '.collab']);
  const changed = [];
  const walk = (dir, depth) => {
    if (depth > 8 || changed.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (changed.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name.toLowerCase())) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(full);
        if (stat.mtimeMs >= window.start && stat.mtimeMs <= window.end) {
          changed.push({ display: displayPath(full, cwd), mtime: stat.mtimeMs, size: stat.size });
        }
      } catch {
        /* vanished mid-scan */
      }
    }
  };
  walk(cwd, 0);
  return changed;
}

function readRunRecords(dir, limit = 20) {
  try {
    const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const runs = [];
    for (const line of lines.slice(-limit)) {
      try {
        runs.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
    return runs;
  } catch {
    try {
      return [JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'))];
    } catch {
      return [];
    }
  }
}

function resolveRound(dir, options = {}) {
  if (typeof options.session === 'string' && options.session.trim()) {
    const sessionId = options.session.trim();
    const parsed = parseCliSession(sessionId) ?? findSessionByPrefix(sessionId);
    if (!parsed) return undefined;
    // The transcript knows nothing about the prompt, so carry it over from the
    // latest recorded round of the same session (UNREAD depends on it).
    const prior = readRunRecords(dir, 50)
      .filter((run) => run.sessionId === parsed.sessionId)
      .pop();
    return {
      at: Date.now(),
      ...(prior?.prompt ? { prompt: prior.prompt } : {}),
      ...(Array.isArray(prior?.requested) ? { requested: prior.requested } : {}),
      ...parsed,
    };
  }
  const runs = readRunRecords(dir, 50);
  if (runs.length === 0) return undefined;
  const back = Number.isInteger(options.run) && options.run > 0 ? options.run : 1;
  if (back > runs.length) return undefined;
  return runs[runs.length - back];
}

function findSessionByPrefix(prefix) {
  let projects;
  try {
    projects = readdirSync(CLI_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let files;
    try {
      files = readdirSync(join(CLI_PROJECTS_DIR, project.name));
    } catch {
      continue;
    }
    const hit = files.find((name) => name.startsWith(prefix) && name.endsWith('.jsonl'));
    if (hit) return parseCliSession(hit.slice(0, -'.jsonl'.length));
  }
  return undefined;
}

const bytes = (size) =>
  size < 1024
    ? `${size} B`
    : size >= 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(1)} MB`
      : `${(size / 1024).toFixed(1)} KB`;

/**
 * The time span one bridged round covers. A CLI session serves many rounds, so
 * its transcript holds every earlier call too — without a round start we would
 * re-verify the whole session on each round.
 */
function roundWindowFor(record, dir) {
  const end = typeof record.endedAt === 'number' ? record.endedAt : Date.now();
  const padded = (from, pad) => ({ start: from - pad, end: end + 5000, from, to: end });
  if (typeof record.roundStartedAt === 'number') return padded(record.roundStartedAt, 1000);
  if (typeof record.startedAt !== 'number') return undefined;
  // Older records have no round start; the previous record of the same session
  // ends the previous round, which is close enough (no padding — its `at` is
  // already after that round's last action).
  const runs = readRunRecords(dir, 50);
  const index = runs.map((run) => run.at).lastIndexOf(record.at);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (runs[i]?.sessionId === record.sessionId && typeof runs[i].at === 'number') {
      return padded(runs[i].at, 0);
    }
  }
  return padded(record.startedAt, 1000);
}

/**
 * Check one bridged round against the filesystem: what it *did* (tool calls in
 * the transcript), what it *says* it did (summary), and what the files prove
 * (mtime, size, hash vs. the CLI's own pre-image backup).
 *
 * Facts win over self-reports: a claim without a call is a FAIL, a call whose
 * content did not change is a FAIL, and files that moved without any call are
 * reported as undeclared changes.
 */
export function verifyRound(dir, options = {}) {
  const record = resolveRound(dir, options);
  if (!record) {
    return { text: '没有可核对的轮次：runs.jsonl 里没有这么多轮，也没指定 session。先派一轮活，或查一下轮次号。' };
  }
  const file = record.file && existsSync(record.file) ? record.file : findCliSessionFile(record.sessionId);
  const events = file ? readCliEvents(file) : undefined;
  if (!events || events.length === 0) {
    return {
      text: `找不到这一轮的 CLI 会话记录（会话 ${record.sessionId ?? '未知'}）。面板能显示、这里读不到的话，多半是记录文件被挪走了。`,
    };
  }

  const cwd = events.find((event) => typeof event.cwd === 'string' && event.cwd)?.cwd ?? options.cwd ?? process.cwd();
  const window = roundWindowFor(record, dir);

  const actions = collectActions(events, window);
  const backups = collectBackups(events, window);
  const claims = extractClaims(record.summary ?? '', cwd);
  const callNames = new Map();
  const results = new Map();
  for (const event of events) {
    if (event?.type === 'function_call' && typeof event.callId === 'string') {
      callNames.set(event.callId, String(event.name ?? '工具'));
    }
    if (event?.type !== 'function_call_result' || typeof event.callId !== 'string') continue;
    results.set(event.callId, {
      status: typeof event.status === 'string' ? event.status : '',
      text: String(event.output?.text ?? event.output ?? '').replace(/\s+/g, ' ').trim(),
      ts: typeof event.timestamp === 'number' ? event.timestamp : undefined,
    });
  }
  const failures = [...results.entries()].filter(
    ([, result]) => result.status && result.status !== 'completed' && withinWindow(result.ts, window),
  );

  const modified = new Map();
  for (const action of actions) {
    if (!MODIFY_TOOLS.has(action.name) || !action.path) continue;
    const key = pathKey(action.path, cwd);
    if (!modified.has(key)) modified.set(key, { display: displayPath(action.path, cwd), actions: [] });
    modified.get(key).actions.push(action);
  }

  const items = [];
  const counts = { pass: 0, fail: 0, warn: 0 };
  const push = (verdict, display, notes) => {
    items.push({ verdict, display, notes });
    if (verdict === 'PASS') counts.pass += 1;
    else if (verdict === 'FAIL') counts.fail += 1;
    else counts.warn += 1;
  };

  for (const [key, entry] of modified) {
    const absolute = resolvePath(cwd, entry.display);
    const facts = fileFacts(absolute);
    const backup = backups.get(key);
    const when = entry.actions.map((action) => (action.ts ? new Date(action.ts).toLocaleTimeString('zh-CN') : '?')).join('/');
    const tools = [...new Set(entry.actions.map((action) => action.name))].join('+');
    const notes = [`${tools} @ ${when}`];
    const callResults = entry.actions
      .map((action) => (action.callId ? results.get(action.callId) : undefined))
      .filter(Boolean);
    const succeeded =
      callResults.length === 0 || callResults.every((result) => !result.status || result.status === 'completed');

    if (!facts.exists) {
      if (succeeded) {
        push('WARN', entry.display, [
          ...notes,
          '当时写成功了，现在文件不在了（之后被删或回滚，不是这一轮的假账）',
        ]);
      } else {
        push('FAIL', entry.display, [
          ...notes,
          '写操作没成功，文件也不存在',
          ...(callResults[0]?.text ? [`返回：${callResults[0].text.slice(0, 120)}`] : []),
        ]);
      }
      continue;
    }

    notes.push(`${bytes(facts.size)} · mtime ${new Date(facts.mtime).toLocaleString('zh-CN')}`);
    if (!succeeded) notes.push('⚠ 那次调用返回非 completed');
    const inWindow = !window || (facts.mtime >= window.start && facts.mtime <= window.end);
    if (!inWindow) notes.push('⚠ mtime 不在这一轮的时间窗内');

    // A physical pre-image beats every weaker signal: if it exists, compare it.
    const backupPath = backup?.backupFileName ? findBackupFile(backup.backupFileName) : undefined;
    if (backupPath) {
      const before = fileFacts(backupPath);
      if (before.exists && before.digest && before.digest === facts.digest) {
        push('FAIL', entry.display, [...notes, '内容与改前完全一致（hash 相同）——空转，报了没做的功']);
      } else if (before.exists) {
        // Content differing from the pre-image is proof on its own; a stale
        // mtime only means something touched it again afterwards.
        push('PASS', entry.display, [
          ...notes,
          `内容已变：${bytes(before.size)} → ${bytes(facts.size)}（对比 CLI 备份 ${before.digest}）`,
        ]);
      } else {
        push('WARN', entry.display, [...notes, '有备份记录但备份文件丢了，只能用 mtime 判断']);
      }
      continue;
    }
    // `existedAtTrack` is a session-level fact ("it did not exist when tracking
    // began"), so it may only speak for files with no pre-image at all.
    if (backup && backup.existedAtTrack === false) {
      push('PASS', entry.display, [...notes, '新建：改动前不存在']);
      continue;
    }
    push('WARN', entry.display, [
      ...notes,
      inWindow ? '没有改前备份可比，只能看 mtime（落窗）' : '没有改前备份可比，mtime 也不在窗内，基本无法证实',
    ]);
  }

  // Claims with no matching call: the summary says it changed something it never touched.
  for (const [key, claim] of claims) {
    if (modified.has(key)) continue;
    const facts = fileFacts(claim.absolute);
    push('FAIL', claim.display, [
      '摘要声称改了它，但这一轮没有任何写操作指向这个文件',
      facts.exists ? `${bytes(facts.size)} · mtime ${new Date(facts.mtime).toLocaleString('zh-CN')}` : '文件也不存在',
    ]);
  }

  // Review rounds leave no writes to compare, so the check is "did it read what
  // it was asked to review". Claimed = files the prompt named ∪ files the summary
  // says it read (advice excluded). A Grep/Glob-only round is downgraded to WARN:
  // searching is not reading, but it is not proof of a fake review either.
  const requested = new Map();
  if (Array.isArray(record.requested)) {
    for (const display of record.requested) {
      if (typeof display !== 'string' || !display) continue;
      const absolute = resolvePath(cwd, display);
      requested.set(pathKey(absolute, cwd), { display, absolute });
    }
  }
  if (requested.size === 0) {
    for (const [key, item] of extractPromptPaths(record.prompt, cwd)) requested.set(key, item);
  }
  if (modified.size === 0 || requested.size > 0) {
    const reads = new Set(
      actions
        .filter((action) => (action.name === 'Read' || action.name === 'ReadImage') && action.path)
        .map((action) => pathKey(action.path, cwd)),
    );
    const searched = actions.some((action) => action.name === 'Grep' || action.name === 'Glob');
    const claimed = new Map([...requested, ...extractMentionedPaths(record.summary ?? '', cwd)]);
    for (const [key, item] of claimed) {
      if (reads.has(key)) continue;
      if (searched) {
        push('WARN', item.display, ['UNREAD?：没看到 Read 它，但这一轮用了 Grep/Glob，可能用搜索核对过']);
        continue;
      }
      push('FAIL', item.display, ['UNREAD：这一轮声称审了它，但没有任何 Read 指向这个文件']);
    }
  }

  // Files that moved on their own: either another process, or it hid a write.
  if (window) {
    const touched = new Set([...modified.keys()]);
    const undeclared = scanChangedFiles(cwd, window)
      .filter((item) => !touched.has(item.display.toLowerCase().replace(/\//g, '\\')))
      .slice(0, 8);
    for (const item of undeclared) {
      push('WARN', item.display, ['这一轮窗内文件变了，但它没有任何写操作指向它（别处改的，或被它漏报）']);
    }
  }

  for (const [callId, failure] of failures.slice(0, 5)) {
    const name = callNames.get(callId) ?? '工具';
    push('FAIL', `工具调用失败：${name}`, [
      failure.text ? `返回：${failure.text.slice(0, 120)}` : `status=${failure.status}`,
    ]);
  }

  const seconds = window ? Math.max(0, Math.round((window.to - window.from) / 1000)) : undefined;
  const head = [
    `核对：${record.sessionId ? `会话 ${String(record.sessionId).slice(0, 8)}` : '某个会话'}` +
      (seconds !== undefined ? ` · 窗口 ${seconds}s` : '') +
      ` · 动作 ${actions.length} 个（${[...new Set(actions.map((action) => action.tag))].join('、') || '无'}）`,
    `声明改动：${claims.size} 处 · 实际写入：${modified.size} 个文件`,
  ];
  const body = items.length > 0 ? items.map((item) => `[${item.verdict}] ${item.display}\n  ${item.notes.join(' · ')}`) : [];
  const verdictLine =
    items.length === 0
      ? '结论：这一轮没有声明改动、也没有写操作，无可核对项。'
      : counts.fail === 0
        ? `结论：PASS ${counts.pass} / FAIL ${counts.fail} / WARN ${counts.warn} —— 没有对不上的地方（WARN 只是没法证实）。`
        : `结论：PASS ${counts.pass} / FAIL ${counts.fail} / WARN ${counts.warn} —— 有对不上的地方，按 FAIL 那几条追。`;
  return { text: [...head, '', ...(body.length ? [...body, ''] : []), verdictLine].join('\n') };
}

/**
 * One engine process, one conversation.
 */
class WorkBuddySession {
  constructor(bridge, key, options) {
    this.bridge = bridge;
    this.key = key;
    this.options = options;
    this.child = undefined;
    this.sessionId = undefined;
    this.turn = undefined;
    this.starting = undefined;
    this.lastUsed = Date.now();
    this.stderr = '';
    this.disposed = false;
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async #start() {
    const bridge = this.bridge;
    const cliPath = bridge.cliPath;
    if (!cliPath) throw new Error('WorkBuddy engine not found. Set WORKBUDDY_CLI_PATH.');

    // The desktop app ships only the reduced (lite-wb) engine bundle.
    const siblingDist = join(dirname(cliPath), '..', 'dist');
    const hasFullBundle = existsSync(join(siblingDist, 'codebuddy.js'));
    const hasHeadlessBundle = existsSync(join(siblingDist, 'codebuddy-headless.js'));
    const needsLiteBundle = !hasFullBundle && !hasHeadlessBundle;

    const args = [
      cliPath,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (this.options.permissionMode) args.push('--permission-mode', this.options.permissionMode);
    for (const tool of this.options.allowedTools) args.push('--allowedTools', tool);
    for (const tool of this.options.disallowedTools) args.push('--disallowedTools', tool);
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.appendSystemPrompt) args.push('--append-system-prompt', this.options.appendSystemPrompt);

    const env = { ...process.env, ...this.bridge.extraEnv };
    if (needsLiteBundle) env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
    if (bridge.productConfig) env.ACC_PRODUCT_CONFIG_PATH = bridge.productConfig;
    if (bridge.authToken) env.CODEBUDDY_AUTH_TOKEN = bridge.authToken;
    if (bridge.apiKey) env.CODEBUDDY_API_KEY = bridge.apiKey;

    const child = spawn(process.execPath, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stderr = '';

    createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR);
    });
    child.on('error', (error) => this.#fail(new Error(`WorkBuddy engine failed to start: ${error.message}`)));
    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.sessionId = undefined;
      if (this.turn) {
        const tail = this.stderr.trim();
        this.#fail(
          new Error(
            `WorkBuddy engine exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).${tail ? `\n${tail}` : ''}`,
          ),
        );
      }
    });
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && typeof event.session_id === 'string') {
          this.sessionId = event.session_id;
        }
        return;
      case 'assistant': {
        const content = event.message?.content;
        if (!Array.isArray(content) || !this.turn) return;
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            this.turn.text.push(block.text);
          } else if (block?.type === 'tool_use') {
            this.turn.actions.push(describeAction(String(block.name ?? ''), block.input));
          }
        }
        return;
      }
      case 'control_request':
        void this.#onControlRequest(event);
        return;
      case 'result': {
        const turn = this.turn;
        if (!turn) return;
        this.turn = undefined;
        turn.clearTimer();
        const reply =
          typeof event.result === 'string' && event.result.trim().length > 0
            ? event.result
            : turn.text.join('').trim();
        const denials = Array.isArray(event.permission_denials)
          ? event.permission_denials.map((denial) => {
              const tool = denial?.tool_name ?? denial?.toolName ?? 'tool';
              return `${tool}: ${summarizeToolInput(denial?.tool_input ?? denial?.input, 300)}`;
            })
          : [];
        const errors = Array.isArray(event.errors) ? event.errors.filter((value) => typeof value === 'string') : [];
        turn.resolve({
          reply,
          actions: turn.actions,
          denials,
          errors,
          sessionId: this.sessionId,
          isError: event.is_error === true || event.subtype !== 'success',
          cancelled: false,
        });
        return;
      }
      case 'error':
        if (this.turn) {
          this.turn.errors.push(String(event.error ?? 'unknown engine error'));
        }
        return;
      default:
        return;
    }
  }

  /** Answer an engine permission prompt through the Harness approval UI. */
  async #onControlRequest(event) {
    const requestId = event.request_id ?? event.requestId;
    const request = event.request ?? {};
    const subtype = request.subtype ?? request.type ?? 'unknown';
    const toolName = request.tool_name ?? request.toolName ?? subtype;
    const input = request.input ?? request.tool_input;

    const allow = await this.bridge.requestApproval({
      agent: this.turn?.agent,
      toolName,
      input,
      signal: this.turn?.signal,
      session: this,
    });

    this.#respondToControl({
      requestId,
      allow,
      message: allow
        ? undefined
        : `DSH 用户没有批准这次 ${String(toolName)} 调用。请换一种不需要该操作的做法，或者把需要决定的事情写在回复里。`,
      updatedInput: input,
    });
  }

  #respondToControl(payload) {
    const child = this.child;
    if (!child?.stdin?.writable) return;
    const response = {
      subtype: 'success',
      request_id: payload.requestId,
      response: payload.allow
        ? { behavior: 'allow', updatedInput: payload.updatedInput }
        : { behavior: 'deny', message: payload.message ?? 'Denied by the DSH user.' },
    };
    try {
      child.stdin.write(`${JSON.stringify({ type: 'control_response', response })}\n`);
    } catch {
      /* the engine is gone; the exit handler reports it */
    }
  }

  #fail(error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.clearTimer();
    turn.reject(error);
  }

  async send(text, { agent, signal } = {}) {
    if (this.disposed) throw new Error('WorkBuddy session was closed.');
    if (this.turn) throw new Error('WorkBuddy is still working on the previous message.');
    await this.ensureStarted();
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error('WorkBuddy engine is not accepting input.');

    this.lastUsed = Date.now();
    const timeoutMs = this.bridge.timeoutMs;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#fail(new Error(`WorkBuddy did not answer within ${Math.round(timeoutMs / 1000)}s.`));
        this.close('timeout');
      }, timeoutMs);
      const onAbort = () => {
        this.#fail(new Error('WorkBuddy turn was cancelled.'));
        this.close('aborted');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.turn = {
        text: [],
        actions: [],
        errors: [],
        agent,
        signal,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolvePromise(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          rejectPromise(error);
        },
        clearTimer: () => clearTimeout(timer),
      };

      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(reason = 'closed') {
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.bridge.forget(this.key, this);
    void reason;
  }
}

class WorkBuddyBridge {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.sessions = new Map();
    this.cliPath = config.cliPath ?? FIRST_OK(CLI_CANDIDATES);
    this.productConfig = config.productConfig ?? FIRST_OK(PRODUCT_CANDIDATES);
    this.authToken = config.authToken;
    this.apiKey = config.apiKey;
    this.extraEnv =
      config.env && typeof config.env === 'object' && !Array.isArray(config.env)
        ? Object.fromEntries(
            Object.entries(config.env).filter(([, value]) => typeof value === 'string' && value.length > 0),
          )
        : {};
    // Shared exchange folder. Defaults to the user's DSH home so a fresh
    // install never writes into whatever directory the host happened to start
    // in; set `collabDir` when you want it inside a project.
    this.collabDir = config.collabDir ?? join(homedir(), '.dsh', 'codebuddy-bridge');
    this.watchMs = Number(config.watchMs) > 0 ? Number(config.watchMs) : 3000;
    this.watchTimer = undefined;
    this.waking = false;
    this.modeFile = join(this.collabDir, 'modes.json');
    this.modes = readModes(this.modeFile);
    this.gates = new Map();
    this.lastModePost = new Map();
    this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.idleMs = Number(config.idleMs) > 0 ? Number(config.idleMs) : DEFAULT_IDLE_MS;
    this.defaults = {
      cwd: config.cwd ?? ctx.get('workingDirectory')?.defaultDirectory ?? process.cwd(),
      model: config.model,
      permissionMode: config.permissionMode ?? 'acceptEdits',
      allowedTools: Array.isArray(config.allowedTools) ? config.allowedTools : [],
      disallowedTools: Array.isArray(config.disallowedTools) ? config.disallowedTools : [],
      appendSystemPrompt:
        config.appendSystemPrompt ??
        [
          '你正在和另一个 AI 代理（DSH）协作：它负责审核你的产出并提出修改意见，最终由人类监督。',
          '需要人类拍板的事情，直接写在回复正文里（不要依赖交互式提问，界面可能无人值守）。',
          '完成一段工作后，简要列出你改了什么、下一步建议。',
        ].join('\n'),
    };
  }

  sessionFor(agent, options = {}) {
    const key = agent?.id ? String(agent.id) : 'global';
    let session = this.sessions.get(key);
    if (session && !session.disposed && options.reset) {
      session.close('reset');
      session = undefined;
    }
    if (!session || session.disposed) {
      session = new WorkBuddySession(this, key, { ...this.defaults, ...options });
      this.sessions.set(key, session);
    }
    return session;
  }

  forget(key, session) {
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  /** Whether collaboration mode is on for one session. */
  isEnabled(sessionId) {
    if (!sessionId) return false;
    return this.modes[String(sessionId)] === true;
  }

  setEnabled(sessionId, enabled) {
    if (!sessionId) return;
    this.modes[String(sessionId)] = enabled === true;
    writeModes(this.modeFile, this.modes);
    this.refreshGates();
  }

  /** While a session is off, its agent cannot even see the collaboration tools. */
  applyGate(agent) {
    if (!agent?.id) return;
    const key = String(agent.id);
    const existing = this.gates.get(key);
    if (this.isEnabled(key)) {
      if (existing) {
        try {
          existing();
        } catch {
          /* already disposed */
        }
        this.gates.delete(key);
      }
      return;
    }
    if (existing) return;
    try {
      const tools = agent.ctx?.tools;
      if (!tools || typeof tools.restrict !== 'function') return;
      const dispose = tools.restrict({ deny: GATED_TOOLS });
      this.gates.set(key, dispose);
    } catch {
      /* a gate failure must not fail agent creation */
    }
  }

  refreshGates() {
    const agents = this.ctx.get('agents');
    for (const agent of agents?.list?.() ?? []) this.applyGate(agent);
  }

  disposeGates() {
    for (const dispose of this.gates.values()) {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
    this.gates.clear();
  }

  async requestApproval({ agent, toolName, input, signal }) {
    const approval = this.ctx.get('approval');
    if (!approval || !agent) return false;
    try {
      const outcome = await approval.request({
        agent,
        toolName: `WorkBuddy·${toolName}`,
        reason: summarizeToolInput(input),
        displayReason: {
          en: `WorkBuddy wants to run ${toolName}.`,
          zh: `WorkBuddy 想执行 ${toolName}。`,
        },
        signal,
      });
      return outcome === 'allowed-once';
    } catch {
      return false;
    }
  }

  /** Poll the shared folder and wake the dispatching agent when WorkBuddy answers. */
  startWatcher() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.#pollOutbox(), this.watchMs);
    this.watchTimer.unref?.();
  }

  stopWatcher() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  #pollOutbox() {
    const state = readState(this.collabDir);
    if (!state) return;

    // 1) still waiting for WorkBuddy to write the hand-back
    if (state.status === 'pending') {
      const outbox = readOutbox(this.collabDir);
      if (!outbox) return;
      const digest = outboxDigest(outbox.text);
      if (digest === state.digest) return;
      const next = {
        ...state,
        status: 'answered',
        answeredAt: Date.now(),
        digest,
        wake: { status: 'retrying', tries: 0 },
      };
      writeState(this.collabDir, next);
      void this.#runWake(next);
      return;
    }

    // 2) answered but not delivered yet: keep trying the remaining call shapes
    const wake = state.wake;
    if (state.status === 'answered' && wake?.status !== 'delivered' && (wake?.tries ?? 0) < WAKE_FORMS.length) {
      if (Date.now() - (wake?.lastTryAt ?? 0) < Math.max(2000, this.watchMs)) return;
      void this.#runWake(state);
    }
  }

  /**
   * Try one call shape per poll, awaiting the result. A resolved promise is the
   * closest thing to an acknowledgement this API offers, so it is recorded as
   * `delivered`; the resolution value is kept for inspection.
   */
  async #runWake(state) {
    if (this.waking) return;
    this.waking = true;
    try {
      const agents = this.ctx.get('agents');
      const agent = state.agentId && agents ? agents.get(state.agentId) : undefined;
      const tries = state.wake?.tries ?? 0;
      const form = WAKE_FORMS[tries];
      const text = [
        `WorkBuddy 已写回第 ${state.round} 轮交接单（.collab/outbox.md 有新内容）。`,
        '用 workbuddy_read 取回并审核；「需要拍板」的条目转给用户。',
      ].join('');

      let outcome;
      if (!agent) outcome = { ok: false, error: 'no-agent（那个会话已经不在线）' };
      else {
        try {
          const message = form.build(text);
          const result = await form.call(agent, message);
          outcome = { ok: true, result: describeValue(result) };
        } catch (error) {
          outcome = { ok: false, error: `${form.name}: ${error instanceof Error ? error.message : String(error)}` };
        }
      }

      const nextTries = tries + 1;
      const status = outcome.ok ? 'delivered' : nextTries >= WAKE_FORMS.length ? 'failed' : 'retrying';
      writeState(this.collabDir, {
        ...state,
        wake: {
          status,
          tries: nextTries,
          form: form.name,
          lastTryAt: Date.now(),
          ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
        },
      });
    } finally {
      this.waking = false;
    }
  }

  /**
   * Keep every bridged round's steps: the panel lists them per round.
   * `roundStartedAt` marks where this round began — a CLI session is reused, so
   * its transcript also holds the earlier rounds and verification needs a cut.
   */
  recordRun(sessionId, roundStartedAt, prompt) {
    const parsed = parseCliSession(sessionId);
    if (!parsed) return;
    try {
      mkdirSync(this.collabDir, { recursive: true });
      // Resolve the "文件：" lines now, while the prompt is whole: truncating it
      // later would silently drop every file named after the cut.
      const requested =
        typeof prompt === 'string' && prompt.trim()
          ? [...extractPromptPaths(prompt, this.defaults.cwd).values()].map((item) => item.display)
          : [];
      const record = {
        at: Date.now(),
        ...parsed,
        ...(typeof roundStartedAt === 'number' ? { roundStartedAt } : {}),
        ...(typeof prompt === 'string' && prompt.trim() ? { prompt: prompt.trim().slice(0, 4000) } : {}),
        ...(requested.length > 0 ? { requested } : {}),
      };
      writeFileSync(join(this.collabDir, 'last-run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      appendFileSync(join(this.collabDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
      this.writeReportMarkdown();
    } catch {
      /* the panel is a convenience */
    }
  }

  /** The CLI bridge row and its editor, when that plugin is installed. */
  cliBridgeRow() {
    const editor = this.ctx.get('configEditor');
    if (!editor || typeof editor.configuration !== 'function') return undefined;
    try {
      const item = editor.configuration().find(({ entry }) => {
        const id = String(entry?.id ?? '');
        const name = String(entry?.name ?? '');
        return id.includes('dsh-connect-workbuddy') || name === 'dsh-connect-workbuddy';
      });
      return item ? { editor, item } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The model the CLI bridge will pass as --model (empty = CLI default). */
  currentModel() {
    const found = this.cliBridgeRow();
    if (!found) return '';
    const { item } = found;
    const value = item.override?.cliBridge?.model ?? item.inherited?.cliBridge?.model;
    return typeof value === 'string' ? value : '';
  }

  /** Models this account's catalog offers, for the picker. */
  modelCatalog() {
    const found = this.cliBridgeRow();
    if (!found) return [];
    const { item } = found;
    const catalog =
      item.override?.regions?.cn?.lastCatalog ?? item.inherited?.regions?.cn?.lastCatalog ?? [];
    if (!Array.isArray(catalog)) return [];
    const models = catalog.filter((model) => model && typeof model.id === 'string');
    // Several ids share a display name (Hy4 free/standard, Hy3/Hy3-X); without
    // the id the picker would show two identical entries.
    const nameCounts = new Map();
    for (const model of models) {
      const name = typeof model.name === 'string' ? model.name : model.id;
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    return models.map((model) => {
      const base = typeof model.name === 'string' ? model.name : model.id;
      const duplicated = (nameCounts.get(base) ?? 0) > 1;
      const free = model.creditMultiplier === 0;
      return {
        id: model.id,
        name: `${base}${duplicated ? ` · ${model.id}` : ''}${free ? '（免费）' : ''}`,
        multiplier: typeof model.creditMultiplier === 'number' ? model.creditMultiplier : undefined,
      };
    });
  }

  /** Temporary diagnostic: what rows the config editor exposes. */
  describeConfigRows() {
    const editor = this.ctx.get('configEditor');
    if (!editor || typeof editor.configuration !== 'function') return { editor: false };
    try {
      const rows = editor.configuration();
      return {
        editor: true,
        count: rows.length,
        rows: rows.slice(0, 40).map(({ entry, override }) => ({
          id: entry?.id,
          name: entry?.name,
          keys: override && typeof override === 'object' ? Object.keys(override).slice(0, 6) : [],
        })),
      };
    } catch (error) {
      return { editor: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Persist a new model through the config editor; the row is volatile, so it applies at once. */
  async setModel(model) {
    const found = this.cliBridgeRow();
    if (!found) return false;
    const { editor, item } = found;
    await editor.edit(item.entry, (current) => ({
      ...current,
      cliBridge: { ...(current.cliBridge ?? {}), model },
    }));
    return true;
  }

  /** A plain markdown report anyone can open — including from the WorkBuddy app. */
  writeReportMarkdown() {
    try {
      const runs = this.readRuns(20);
      const lines = ['# CodeBuddy 协作记录', '', `更新时间：${new Date().toLocaleString('zh-CN')}`, ''];
      if (runs.length === 0) {
        lines.push('（还没有记录。派一轮活之后这里会出现明细。）');
      }
      for (const run of [...runs].reverse()) {
        const when = new Date(run.at ?? Date.now()).toLocaleString('zh-CN');
        lines.push(`## ${when} · ${run.stepCount ?? (run.steps ?? []).length} 个工具`, '');
        for (const step of (run.steps ?? []).slice(-12)) {
          lines.push(`- **${step.tag}** ${String(step.text ?? '').replace(/\s+/g, ' ')}`);
        }
        if (run.summary) lines.push('', `> ${String(run.summary).replace(/\s+/g, ' ').slice(0, 300)}`);
        lines.push('');
      }
      writeFileSync(join(this.collabDir, 'report.md'), `${lines.join('\n')}\n`, 'utf8');
    } catch {
      /* the report is a convenience */
    }
  }

  /** The most recent bridged rounds, newest last. */
  readRuns(limit = 12) {
    try {
      const lines = readFileSync(join(this.collabDir, 'runs.jsonl'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      const runs = [];
      for (const line of lines.slice(-limit)) {
        try {
          runs.push(JSON.parse(line));
        } catch {
          /* skip a torn line */
        }
      }
      return runs;
    } catch {
      // Older installs only kept the last round; show that one rather than none.
      try {
        return [JSON.parse(readFileSync(join(this.collabDir, 'last-run.json'), 'utf8'))];
      } catch {
        return [];
      }
    }
  }

  dispose() {
    this.stopWatcher();
    this.disposeGates();
    for (const session of [...this.sessions.values()]) session.close('plugin unloaded');
    this.sessions.clear();
  }
}

/** Call shapes tried in order, one per poll, until one resolves. */
const WAKE_FORMS = [
  {
    name: 'followup-usermessage',
    build: (text) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
    call: (agent, message) => agent.followup(message),
  },
  {
    name: 'followup-usermessage-no-id',
    build: (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
    call: (agent, message) => agent.followup(message),
  },
  {
    name: 'followup-content-only',
    build: (text) => ({ content: [{ type: 'text', text }] }),
    call: (agent, message) => agent.followup(message),
  },
  {
    name: 'inject-usermessage',
    build: (text) => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
    call: (agent, message) => agent.inject(message),
  },
];

function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') return `${typeof value}:${String(value).slice(0, 120)}`;
  try {
    const keys = Object.keys(value).slice(0, 8);
    return `object{${keys.join(',')}} ${JSON.stringify(value).slice(0, 200)}`;
  } catch {
    return 'object(unserializable)';
  }
}

function renderTaskResult(value) {
  const lines = [];
  if (value.reply) {
    lines.push(value.reply);
  } else {
    lines.push('（WorkBuddy 没有返回文字。）');
  }
  if (value.actions?.length) {
    lines.push('', '执行动作：', ...value.actions.slice(0, 40).map((action) => `- ${action}`));
  }
  if (value.denied?.length) {
    lines.push('', '被拦下的操作（想放行就告诉 DSH，下一轮可以再授权）：', ...value.denied.map((item) => `- ${item}`));
  }
  if (value.errors?.length) {
    lines.push('', '引擎报错：', ...value.errors.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}

const taskOutput = {
  schema: {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      actions: { type: 'array', items: { type: 'string' } },
      denied: { type: 'array', items: { type: 'string' } },
      errors: { type: 'array', items: { type: 'string' } },
      sessionId: { type: 'string' },
    },
    required: ['reply'],
  },
  render(_args, value) {
    return [{ type: 'text', text: renderTaskResult(value) }];
  },
};

export function apply(ctx, config = {}) {
  const bridge = new WorkBuddyBridge(ctx, config);
  ctx.effect(() => () => bridge.dispose());
  bridge.startWatcher();
  bridge.writeReportMarkdown();

  // Per-session collaboration switch: off by default, flipped from the UI pill.
  const webServer = ctx.get('webServer');
  try {
    appendFileSync(
      join(bridge.collabDir, 'mode-log.jsonl'),
      `${JSON.stringify({ at: Date.now(), boot: true, hasWebServer: Boolean(webServer) })}\n`,
      'utf8',
    );
  } catch {
    /* diagnostic only */
  }
  if (webServer) {
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/plugins/codebuddy-bridge/mode',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'GET') {
              sendJson(res, 200, { enabled: bridge.isEnabled(url.searchParams.get('sessionId') ?? '') });
              return;
            }
            if (req.method === 'POST') {
              const body = JSON.parse((await readRequestBody(req)) || '{}');
              try {
                appendFileSync(
                  join(bridge.collabDir, 'mode-log.jsonl'),
                  `${JSON.stringify({ at: Date.now(), sessionId: body?.sessionId, enabled: body?.enabled })}\n`,
                  'utf8',
                );
              } catch {
                /* logging is diagnostic only */
              }
              // A click occasionally arrives twice; the second delivery within
              // this window is the same intent, not a second toggle. Kept short
              // so a deliberate second click is never swallowed.
              const key = body?.sessionId ? String(body.sessionId) : '';
              const now = Date.now();
              const last = bridge.lastModePost.get(key) ?? 0;
              if (!key || now - last >= 150) {
                if (key) bridge.lastModePost.set(key, now);
                bridge.setEnabled(body?.sessionId, body?.enabled === true);
              }
              sendJson(res, 200, { enabled: bridge.isEnabled(body?.sessionId) });
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/plugins/codebuddy-bridge/model',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          try {
            const body = JSON.parse((await readRequestBody(req)) || '{}');
            const model = typeof body?.model === 'string' ? body.model.trim() : '';
            const ok = await bridge.setModel(model);
            sendJson(res, 200, { ok, model: bridge.currentModel() });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/plugins/codebuddy-bridge/last-run',
        handler: (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const sessionId = url.searchParams.get('sessionId') ?? '';
            const runs = bridge.readRuns();
            const run = runs.length > 0 ? runs[runs.length - 1] : null;
            // One poll carries the switch, the newest round and the history, so
            // the panel and the pill always agree with the host.
            sendJson(res, 200, {
              ...(run ?? {}),
              enabled: bridge.isEnabled(sessionId),
              run,
              runs,
              model: bridge.currentModel(),
              models: bridge.modelCatalog(),
            });
          } catch (error) {
            sendJson(res, 200, { enabled: false, run: null, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );
  }
  ctx.on('agent/created', ({ agent }) => {
    bridge.applyGate(agent);
  });
  bridge.refreshGates();

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_task',
      description:
        '把当前任务或审核意见交给本机的 WorkBuddy 代理执行一轮，并返回它的回复、动作清单和被拦下的操作。' +
        '同一个 DSH 会话里连续调用会保持同一个 WorkBuddy 会话，因此可以来回协商。' +
        '需要人类批准的操作会以 DSH 审批卡片的形式出现。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '发给 WorkBuddy 的话：任务、要求、或对上一轮产出的审核意见。',
          },
          cwd: {
            type: 'string',
            description: '可选：WorkBuddy 的工作目录，默认沿用 DSH 会话目录。',
          },
          reset: {
            type: 'boolean',
            description: '可选：丢弃已有对话，开一个新的 WorkBuddy 会话。',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: taskOutput,
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
      async execute(args, exec) {
        if (!bridge.isEnabled(exec.agent?.id)) {
          throw new Error('协作模式没开：先在输入框下方点一下「CodeBuddy 协作」。');
        }
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) throw new Error('prompt 不能为空。');
        const cwd = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : bridge.defaults.cwd;
        const session = bridge.sessionFor(exec.agent, { cwd, reset: args?.reset === true });
        const result = await session.send(prompt, { agent: exec.agent, signal: exec.signal });
        return {
          reply: result.reply ?? '',
          actions: result.actions ?? [],
          denied: result.denials ?? [],
          errors: result.errors ?? [],
          sessionId: result.sessionId ?? '',
        };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_status',
      description: '查看 WorkBuddy 桥接状态：引擎路径、登录配置、以及当前 DSH 会话里已打开的 WorkBuddy 会话。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(_args, exec) {
        const key = exec.agent?.id ? String(exec.agent.id) : 'global';
        const session = bridge.sessions.get(key);
        const state = readState(bridge.collabDir);
        const lines = [
          `引擎：${bridge.cliPath ?? '（未找到）'}`,
          `产品配置：${bridge.productConfig ?? '（未使用）'}`,
          `认证：${bridge.authToken ? '环境变量 CODEBUDDY_AUTH_TOKEN' : bridge.apiKey ? '环境变量 CODEBUDDY_API_KEY' : '引擎自身登录态（需先在 WorkBuddy 引擎里 /login）'}`,
          `权限模式：${bridge.defaults.permissionMode}`,
          `工作目录：${session?.options?.cwd ?? bridge.defaults.cwd}`,
          `当前会话：${session ? (session.disposed ? '已关闭' : session.sessionId ?? '已启动，尚未产生会话 ID') : '未启动'}`,
          `交换目录：${bridge.collabDir}`,
          `轮次状态：${state ? `第 ${state.round} 轮 · ${state.status === 'pending' ? '等待 WorkBuddy 写回' : '已收到交接单'}` : '还没派过活'}`,
          `唤醒：${
            state?.wake
              ? `${state.wake.status}（${state.wake.form ?? '—'}，第 ${state.wake.tries ?? 0} 次）${
                  state.wake.error ? ` · 错：${state.wake.error}` : ''
                }${state.wake.result ? ` · 返回：${state.wake.result}` : ''}`
              : '—'
          }`,
          `协作模式：${bridge.isEnabled(exec.agent?.id) ? '开（本会话可调用 CodeBuddy）' : '关（工具已从本会话收走，请用户点输入框下方的「CodeBuddy 协作」开启）'}`,
          `模型：${bridge.currentModel() || '默认（CLI 自选）'}`,
          `看门狗：${bridge.watchTimer ? `运行中（每 ${Math.round(bridge.watchMs / 1000)} 秒查一次 outbox）` : '未运行'}`,
        ];
        return { text: lines.join('\n') };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_dispatch',
      description:
        '把一份任务书写进和 WorkBuddy 共享的目录，并返回该在 WorkBuddy 里敲的命令。' +
        'WorkBuddy 桌面版没有可用的 API/登录态共享，这是当前唯一稳定的派活通道：你写好任务书，用户在 WorkBuddy 里执行 /dsh-handoff，' +
        '它干完后把结果写回 outbox，再用 workbuddy_read 取回。',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '任务书正文：要它做什么、验收标准、边界和不要碰的东西。',
          },
          force: {
            type: 'boolean',
            description: '上一轮还没写回时是否强制覆盖任务书（默认 false，会拒绝并提示）。',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args, exec) {
        if (!bridge.isEnabled(exec.agent?.id)) {
          return {
            text: '协作模式没开：先在输入框下方点一下「CodeBuddy 协作」，再派活。',
          };
        }
        const task = typeof args?.task === 'string' ? args.task.trim() : '';
        if (!task) throw new Error('task 不能为空。');
        const previous = readState(bridge.collabDir);
        if (previous?.status === 'pending' && args?.force !== true) {
          return {
            text: [
              `第 ${previous.round} 轮还在等 WorkBuddy 写回（outbox 仍是占位）。`,
              '先让对方跑一次 /dsh-handoff；确认要放弃上一轮、直接覆盖任务书时，带 force: true 再派。',
            ].join('\n'),
          };
        }
        mkdirSync(bridge.collabDir, { recursive: true });
        const inboxPath = join(bridge.collabDir, 'inbox.md');
        const outboxPath = join(bridge.collabDir, 'outbox.md');
        const stamp = new Date().toLocaleString('zh-CN');
        const round = (Number(previous?.round) || 0) + 1;
        writeFileSync(
          inboxPath,
          [
            '# 来自 DSH 的任务书',
            '',
            `- 轮次：${round}`,
            `- 发出时间：${stamp}`,
            '- 回复方式：把结果写进同目录的 `outbox.md`',
            '',
            '## 任务',
            '',
            task,
            '',
          ].join('\n'),
          'utf8',
        );
        const placeholder = [
          '# WorkBuddy → DSH 交接单',
          '',
          `- 轮次：${round}`,
          '',
          '（这里留给 WorkBuddy 填写：做了什么、产出、需要拍板的问题、还没做的。）',
          '',
        ].join('\n');
        writeFileSync(outboxPath, placeholder, 'utf8');
        writeState(bridge.collabDir, {
          round,
          status: 'pending',
          agentId: exec.agent?.id,
          dispatchedAt: Date.now(),
          digest: outboxDigest(placeholder),
        });
        bridge.startWatcher();
        return {
          text: [
            `任务书已写入：${inboxPath}（第 ${round} 轮）`,
            '',
            '派活方式（当前唯一可用）：请对方在 WorkBuddy 里输入',
            '',
            '    /dsh-handoff',
            '',
            'WorkBuddy 会读这份任务书、干完把结果写进 outbox。',
            '之后桥会在后台盯着 outbox，变了就尝试叫醒这条会话（不保证叫得醒，收到提醒后再用 workbuddy_read 取回）。',
          ].join('\n'),
        };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_read',
      description:
        '读取 WorkBuddy 桌面版最近一次工作的会话记录（它的回答和你给它的任务），用来审核它的产出。' +
        '不依赖引擎登录态，直接读本机会话文件。',
      parameters: {
        type: 'object',
        properties: {
          turns: {
            type: 'integer',
            description: '可选：读取最后多少轮对话，默认 8。',
          },
          session: {
            type: 'string',
            description: '可选：指定会话 ID（或它的前几位）。不填就取最近修改的那个会话。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args) {
        const wantedTurns = Number.isInteger(args?.turns) && args.turns > 0 ? Math.min(args.turns, 50) : 8;
        const outbox = readOutbox(bridge.collabDir);
        const state = readState(bridge.collabDir);
        const parts = [];
        if (!outbox && state?.status === 'pending') {
          parts.push(`第 ${state.round} 轮任务书已发出，outbox 还是占位——WorkBuddy 可能还没执行 /dsh-handoff。`);
          parts.push('');
        }
        if (outbox) {
          parts.push('=== WorkBuddy 写回的交接单 ===');
          parts.push(outbox.text);
          parts.push('');
          parts.push('=== 它最近的会话记录 ===');
          parts.push('');
        }
        const transcripts = listTranscripts();
        if (transcripts.length === 0) {
          parts.push(`没有找到 WorkBuddy 的会话记录（${TRANSCRIPTS_DIR}）。先在 WorkBuddy 里跑一次任务。`);
          return { text: parts.join('\n') };
        }
        const wanted = typeof args?.session === 'string' ? args.session.trim() : '';
        const entry = wanted ? transcripts.find((item) => item.session.startsWith(wanted)) : transcripts[0];
        if (!entry) {
          parts.push(
            `没有找到匹配 ${wanted} 的 WorkBuddy 会话。最近的会话：${transcripts
              .slice(0, 5)
              .map((item) => item.session.slice(0, 8))
              .join('、')}`,
          );
          return { text: parts.join('\n') };
        }
        const turns = digestTranscript(entry, wantedTurns);
        if (turns.length === 0) {
          parts.push(`会话 ${entry.session.slice(0, 8)} 里还没有可读的对话内容。`);
          return { text: parts.join('\n') };
        }
        parts.push(formatTranscript(entry, turns));
        return { text: parts.join('\n') };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_verify',
      description:
        '核对 WorkBuddy/CodeBuddy 最近一轮到底改没改：从它的 CLI 会话记录里取动作与时间窗，' +
        '再用 CLI 自己留的改前备份做内容 diff，逐条给出 PASS/FAIL/WARN 和证据。' +
        '不调引擎、不花额度，协作模式关着也能审旧账。写报告/说「我改好了」之后，先用它验一遍再信。',
      parameters: {
        type: 'object',
        properties: {
          run: {
            type: 'integer',
            description: '可选：审倒数第几轮（默认 1 = 最近一轮）。',
          },
          session: {
            type: 'string',
            description: '可选：直接指定 CLI 会话 ID 或它的前几位，忽略 runs.jsonl。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args) {
        try {
          return verifyRound(bridge.collabDir, {
            run: args?.run,
            session: args?.session,
            cwd: bridge.defaults.cwd,
          });
        } catch (error) {
          return { text: `核对失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_probe',
      description: '调试用：打印当前会话 Agent 对象上和唤醒相关的方法签名，用来确认 followup/inject 的调用方式。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(_args, exec) {
        const agent = exec.agent;
        if (!agent) return { text: '没有 agent。' };
        let protoKeys = [];
        try {
          let proto = Object.getPrototypeOf(agent);
          const seen = new Set();
          while (proto && protoKeys.length < 80) {
            for (const key of Object.getOwnPropertyNames(proto)) if (!seen.has(key)) seen.add(key);
            proto = Object.getPrototypeOf(proto);
          }
          protoKeys = [...seen];
        } catch (error) {
          protoKeys = [`<读取失败: ${error instanceof Error ? error.message : String(error)}>`];
        }
        const detail = (name) => {
          const fn = agent[name];
          if (typeof fn !== 'function') return `${name}: 不是函数（${typeof fn}）`;
          let src = '';
          try {
            src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, 900);
          } catch {
            src = '<不可读>';
          }
          return `${name}: 参数个数 ${fn.length}，源码 ${src}`;
        };
        let ownKeys = [];
        try {
          ownKeys = Object.keys(agent).slice(0, 30);
        } catch {
          ownKeys = ['<读取失败>'];
        }
        const lines = [
          `agent.id: ${agent.id}`,
          `实例字段: ${ownKeys.join(', ')}`,
          `原型方法: ${protoKeys.join(', ')}`,
          detail('followup'),
          detail('inject'),
          detail('send'),
          detail('preStep'),
          detail('step'),
        ];
        try {
          const inbox = agent.inbox;
          lines.push(`inbox 形状: ${inbox ? Object.keys(inbox).map((k) => `${k}=${Array.isArray(inbox[k]) ? inbox[k].length : typeof inbox[k]}`).join(', ') : '无'}`);
        } catch (error) {
          lines.push(`inbox 读取失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const messages = agent.session?.deriveMessages?.() ?? [];
          const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
          lines.push(`最近一条 user 消息: ${lastUser ? JSON.stringify(lastUser).slice(0, 700) : '（无）'}`);
        } catch (error) {
          lines.push(`消息读取失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { text: lines.join('\n') };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_relay',
      description:
        '替用户敲一次 /codebuddy，把任务交给 dsh-connect-workbuddy 的 CLI 路线：结论会以会话消息回注（界面上看得见），' +
        '运行期间输入框下方还有实时胶囊显示它在干什么。适合"让 WorkBuddy 干一轮、我在对话里接着看结果"。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '交给 CodeBuddy 的话；留空等于"评审当前工作区未提交的改动"。' },
          edit: { type: 'boolean', description: '这一轮是否允许它改文件（等价于 /codebuddy --edit）。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args, exec) {
        if (!bridge.isEnabled(exec.agent?.id)) {
          return { text: '协作模式没开：先在输入框下方点一下「CodeBuddy 协作」。' };
        }
        const commands = ctx.get('commands');
        if (!commands) return { text: '这个部署没有 commands 服务。' };
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
        const line = `/codebuddy${args?.edit === true ? ' --edit' : ''}${prompt ? ` ${prompt}` : ''}`;
        const roundStartedAt = Date.now();
        let result;
        try {
          result = await commands.execute(exec.agent, line, [], exec.signal);
        } catch (error) {
          return { text: `调用 /codebuddy 失败：${error instanceof Error ? error.message : String(error)}` };
        }
        if (!result) return { text: '命令没解析成功——确认 dsh-connect-workbuddy 的 cliBridge 已打开、/codebuddy 存在。' };
        const failure = result.result?.kind === 'error' ? String(result.result.text ?? '') : '';
        if (failure) return { text: `CodeBuddy 这一轮失败：${failure}` };
        const output = String(result.result?.text ?? '');
        const sessionMatch = /session_id=([0-9a-zA-Z-]+)/.exec(output);
        if (sessionMatch) bridge.recordRun(sessionMatch[1], roundStartedAt, prompt);
        return {
          text: [
            '已交给 /codebuddy，它跑完会把结论作为消息回注到本会话（界面上能看到），运行中看输入框下方的胶囊。',
            '回注之后建议用 workbuddy_verify 核对它到底改了什么——那是证据，不是它的自述。',
          ].join(''),
        };
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'workbuddy_close',
      description: '结束当前 DSH 会话关联的 WorkBuddy 会话进程。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(_args, exec) {
        const key = exec.agent?.id ? String(exec.agent.id) : 'global';
        const session = bridge.sessions.get(key);
        if (!session) return { text: '没有正在运行的 WorkBuddy 会话。' };
        session.close('closed by tool');
        return { text: '已结束 WorkBuddy 会话。' };
      },
    }),
  );
}
