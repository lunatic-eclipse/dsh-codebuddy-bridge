// SPDX-License-Identifier: MIT
/**
 * Regression tests for the round verifier.
 *
 * The verifier is the part users trust to say "it really changed this", so the
 * tests pin each verdict branch: changed, unchanged, created, claimed-but-not-
 * done, read-only, and the multi-round cut.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';

// index.js resolves the CLI's backup store from USERPROFILE at import time, so
// point that at a scratch home before loading the module.
const home = mkdtempSync(join(tmpdir(), 'cbb-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const BACKUP = 'cafebabe@v1';
const backupDir = join(home, '.codebuddy', 'file-history', 'msg-1');
mkdirSync(backupDir, { recursive: true });
const BEFORE = '改前的内容\n';
writeFileSync(join(backupDir, BACKUP), BEFORE, 'utf8');

const { verifyRound, buildReviewPrompt, apply } = await import('../index.js');

const T0 = Date.now() - 600000;

function round(name, { summary, withWrite = true, withBackup = true, existedAtTrack = true, content, mtime, prompt, reads = [] }) {
  const dir = mkdtempSync(join(tmpdir(), `cbb-${name}-`));
  const file = join(dir, 'note.md');
  writeFileSync(file, content ?? '改后的内容，比原来多一行\n', 'utf8');
  if (mtime) {
    utimesSync(file, new Date(mtime), new Date(mtime));
  }
  const backup = { version: 1, backupTime: T0 + 10, existedAtTrack };
  if (withBackup) backup.backupFileName = BACKUP;
  const events = [
    { type: 'message', role: 'user', timestamp: T0, cwd: dir, content: [{ type: 'input_text', text: 'go' }] },
    {
      type: 'file-history-snapshot',
      timestamp: T0 + 10,
      snapshot: { trackedFileBackups: { 'note.md': backup } },
    },
  ];
  for (const [index, name_] of reads.entries()) {
    const target = join(dir, name_);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '被读的文件\n', 'utf8');
    events.push({
      type: 'function_call',
      name: 'Read',
      callId: `read-${index}`,
      timestamp: T0 + 1500 + index,
      arguments: JSON.stringify({ file_path: target }),
    });
  }
  if (withWrite) {
    events.push({
      type: 'function_call',
      name: 'Edit',
      callId: 'call-1',
      timestamp: T0 + 2000,
      arguments: JSON.stringify({ file_path: file }),
    });
    events.push({
      type: 'function_call_result',
      name: 'Edit',
      callId: 'call-1',
      status: 'completed',
      timestamp: T0 + 2200,
      output: { type: 'text', text: 'ok' },
    });
  }
  const transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  writeFileSync(
    join(dir, 'runs.jsonl'),
    `${JSON.stringify({
      at: T0 + 3000,
      sessionId: name,
      file: transcript,
      summary,
      ...(prompt ? { prompt } : {}),
      startedAt: T0,
      endedAt: T0 + 3000,
      steps: [],
      stepCount: 0,
    })}\n`,
    'utf8',
  );
  return dir;
}

test('content differs from the pre-image → PASS', () => {
  const text = verifyRound(round('edited', { summary: '已修改 note.md', mtime: T0 + 2500 }), {}).text;
  assert.match(text, /\[PASS\]/);
  assert.match(text, /内容已变/);
});

test('content equals the pre-image → FAIL (reported work it did not do)', () => {
  const text = verifyRound(round('noop', { summary: '已修改 note.md', content: BEFORE }), {}).text;
  assert.match(text, /\[FAIL\]/);
  assert.match(text, /空转/);
});

test('no pre-image and the file did not exist before → PASS as a new file', () => {
  const dir = round('created', {
    summary: '已创建 note.md',
    withBackup: false,
    existedAtTrack: false,
    mtime: T0 + 2500,
  });
  const text = verifyRound(dir, {}).text;
  assert.match(text, /\[PASS\]/);
  assert.match(text, /新建/);
});

test('the summary claims an edit but no tool touched the file → FAIL', () => {
  const text = verifyRound(round('ghost', { summary: '已修改 note.md 和 ghost.md', withWrite: false }), {}).text;
  assert.match(text, /\[FAIL\][\s\S]*自述无据|\[FAIL\][\s\S]*没有任何写操作/);
});

test('a read-only round has nothing to verify', () => {
  const text = verifyRound(round('readonly', { summary: '只读审查，没有改动', withWrite: false }), {}).text;
  assert.match(text, /无可核对项/);
  assert.match(text, /实际写入：0 个文件/);
});

test('review round that never read the requested file → FAIL (UNREAD)', () => {
  const dir = round('unread', {
    summary: '审了 b.md，没发现可报的问题',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：a.md\n不要改任何文件。',
    reads: ['b.md'],
  });
  const text = verifyRound(dir, {}).text;
  assert.match(text, /\[FAIL\] a\.md/);
  assert.match(text, /UNREAD/);
});

test('review round that read the requested file → nothing to flag', () => {
  // Negative control first: without it, a broken extractor (empty claim set)
  // would also produce "no UNREAD" and the test would pass for the wrong reason.
  const missed = round('reviewed-miss', {
    summary: '读完了',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：a.md',
    reads: ['b.md'],
  });
  assert.match(verifyRound(missed, {}).text, /\[FAIL\] a\.md/);

  const dir = round('reviewed', {
    summary: '读完了，没有可报的问题',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：a.md',
    reads: ['a.md'],
  });
  const text = verifyRound(dir, {}).text;
  assert.doesNotMatch(text, /UNREAD/);
  assert.match(text, /无可核对项/);
});

test('uppercase extensions are extracted, and case differences still count as read', () => {
  // Extraction must actually find A.MD — otherwise the "no UNREAD" case below
  // would pass for the wrong reason (empty claim set).
  const missed = round('case-miss', {
    summary: '审完了',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：A.MD',
    reads: ['b.md'],
  });
  const missedText = verifyRound(missed, {}).text;
  assert.match(missedText, /\[FAIL\] A\.MD/);
  assert.match(missedText, /UNREAD/);

  const ok = round('case-ok', {
    summary: '读完了',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：A.MD',
    reads: ['a.md'],
  });
  assert.doesNotMatch(verifyRound(ok, {}).text, /UNREAD/);
});

test('forward slashes in the prompt still identify the same file', () => {
  // Positive control: a forward-slash prompt must be extracted at all,
  // otherwise the "no UNREAD" half below would pass with an empty claim set.
  const missed = round('sep-miss', {
    summary: '读完了',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：src/a.md',
    reads: ['b.md'],
  });
  assert.match(verifyRound(missed, {}).text, /\[FAIL\] src\\a\.md/);

  const ok = round('sep', {
    summary: '读完了',
    withWrite: false,
    prompt: '任务：只读审查。\n文件：src\\a.md',
    reads: ['src/a.md'],
  });
  assert.doesNotMatch(verifyRound(ok, {}).text, /UNREAD/);
});

test('a review round that writes anything fails the read-only contract', () => {
  const dir = round('readonly-write', {
    summary: '审完了',
    withWrite: true,
    prompt: '文件：note.md',
  });
  const text = verifyRound(dir, { expectReadOnly: true }).text;
  assert.match(text, /只读轮发生了写操作/);
  assert.match(text, /\[FAIL\] note\.md/);
});

test('the review prompt is fixed: read-only, capped, and short', () => {
  const prompt = buildReviewPrompt('a.js', '', undefined);
  assert.match(prompt, /只读审查/);
  assert.match(prompt, /文件：a\.js/);
  assert.match(prompt, /最多 3 条/);
  assert.match(prompt, /200 字内/);
  assert.doesNotMatch(prompt, /只看：/);
});

test('focus and maxFindings only add detail, never drop the core rules', () => {
  const prompt = buildReviewPrompt('a.js', 'verifyRound 的并发', 9);
  assert.match(prompt, /只看：verifyRound 的并发/);
  assert.match(prompt, /最多 5 条/);
  assert.match(prompt, /只读审查/);
  assert.match(prompt, /不要修改任何文件/);
});

test('rounds of one CLI session do not bleed into each other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-isolation-'));
  const file = join(dir, 'note.md');
  writeFileSync(file, '一轮写的\n', 'utf8');
  const transcript = join(dir, 'session.jsonl');
  const events = [
    { type: 'message', role: 'user', timestamp: T0, cwd: dir, content: [{ type: 'input_text', text: 'go' }] },
    {
      type: 'function_call',
      name: 'Write',
      callId: 'w1',
      timestamp: T0 + 500,
      arguments: JSON.stringify({ file_path: file }),
    },
    {
      type: 'function_call_result',
      name: 'Write',
      callId: 'w1',
      status: 'completed',
      timestamp: T0 + 600,
      output: { type: 'text', text: 'ok' },
    },
    {
      type: 'function_call',
      name: 'Read',
      callId: 'r1',
      timestamp: T0 + 2000,
      arguments: JSON.stringify({ file_path: file }),
    },
  ];
  writeFileSync(transcript, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  const base = { sessionId: '01a1ab51-0000-0000-0000-000000000000', file: transcript, steps: [], stepCount: 0 };
  writeFileSync(
    join(dir, 'runs.jsonl'),
    [
      JSON.stringify({ at: T0 + 1000, ...base, summary: '写了 note.md', startedAt: T0, endedAt: T0 + 800 }),
      JSON.stringify({ at: T0 + 3000, ...base, summary: '只读看了看', startedAt: T0, endedAt: T0 + 3000 }),
    ].join('\n') + '\n',
    'utf8',
  );
  const second = verifyRound(dir, { run: 1 }).text;
  assert.match(second, /实际写入：0 个文件/);
  assert.match(second, /无可核对项/);
});

/**
 * DSH serializes every registered tool spec into the `request/header` session
 * event. `snapshotJsonValue()` requires a *lossless* JSON value: undefined,
 * functions, symbols, bigint, NaN/Infinity, -0, class instances and cycles all
 * make the append fail with "session event \"request/header\" carries
 * non-JSON-serializable data" — which kills every turn after a restart.
 */
function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    ancestors.add(value);
    const ok = value.every((entry) => isJsonValue(entry, ancestors));
    ancestors.delete(value);
    return ok;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(value).some((key) => Object.prototype.propertyIsEnumerable.call(value, key))) return false;
  ancestors.add(value);
  for (const key of Object.keys(value)) {
    if (!isJsonValue(value[key], ancestors)) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

test('every registered tool spec survives the request/header JSON snapshot', () => {
  const specs = [];
  const disposers = [];
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    set: () => {},
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    tools: {
      register: (spec) => {
        specs.push(spec);
        return () => {};
      },
    },
  };
  const collabDir = join(home, 'bridge-tools');
  mkdirSync(collabDir, { recursive: true });

  try {
    apply(ctx, { collabDir, cwd: home, watchMs: 60_000 });
    assert.ok(specs.length >= 8, `expected the tool registrations, got ${specs.length}`);
    for (const spec of specs) {
      const label = spec.name ?? '<unnamed tool>';
      assert.equal(typeof spec.name, 'string', `${label}: missing name puts undefined into request/header`);
      assert.ok(spec.name.length > 0, `${label}: empty name`);
      for (const field of ['name', 'description', 'parameters', 'timeoutMs']) {
        if (field in spec) {
          assert.ok(isJsonValue(spec[field]), `${label}.${field} is not losslessly JSON-serializable`);
        }
      }
      if (spec.output && 'schema' in spec.output) {
        assert.ok(isJsonValue(spec.output.schema), `${label}.output.schema is not losslessly JSON-serializable`);
      }
    }
  } finally {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* cleanup must not mask the assertion */
      }
    }
  }
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});
