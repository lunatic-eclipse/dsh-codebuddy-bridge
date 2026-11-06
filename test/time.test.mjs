// SPDX-License-Identifier: MIT
/**
 * Regression tests for the session time split (thinking vs tool running).
 *
 * The split is what the panel shows, so the boundaries matter: a step's model
 * time is `step/start → assistant/message`, a tool's time is
 * `tool/call → tool/result`, and a result whose call was never seen (torn log)
 * must be ignored rather than counted. The zstd frame walk is only testable on
 * Node 22.15+ (DSH runs 24); those cases skip on an older host instead of
 * pretending to pass.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

const home = mkdtempSync(join(tmpdir(), 'cbb-time-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { splitSessionEvents, summarizeSessionTime, apply } = await import('../index.js');

const temporary = [home];
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-time-dir-'));
  temporary.push(dir);
  return dir;
}

/** One session-log event; only `type`, `time` and `data` matter here. */
const event = (type, time, data = {}) => JSON.stringify({ type, seq: 0, time, data });
const callId = (id) => ({ callId: id });
const resultFor = (id) => ({ message: { toolCallId: id, source: { kind: 'tool', callId: id } } });

test('thinking and tool time are split at the documented boundaries', () => {
  const log = [
    event('turn/start', 0),
    event('step/start', 1000),
    event('assistant/message', 4000), // 3s thinking
    event('tool/call', 4100, { ...callId('c1'), name: 'workbuddy_relay' }),
    event('tool/result', 41_100, resultFor('c1')), // 37s of WorkBuddy
    event('step/start', 41_200),
    event('assistant/message', 43_200), // 2s thinking
    event('tool/call', 43_300, { ...callId('c2'), name: 'read' }),
    event('tool/result', 43_800, resultFor('c2')), // 0.5s other
    event('turn/end', 44_000),
  ].join('\n');

  const split = splitSessionEvents(log);
  assert.equal(split.thinkMs, 5000);
  assert.equal(split.workbuddyMs, 37_000);
  assert.equal(split.otherMs, 500);
  assert.equal(split.toolsMs, 37_500);
  assert.equal(split.turns, 1);
  assert.deepEqual(split.byTool[0], { name: 'workbuddy_relay', ms: 37_000 });
});

test('an orphaned tool result and a torn line are ignored, not counted', () => {
  const log = [
    event('step/start', 0),
    event('assistant/message', 1000),
    event('tool/result', 2000, resultFor('never-called')),
    '{"type": "tool/call", "time": 3000, "data": {"callId": "broken"',
    event('turn/start', 3000),
  ].join('\n');

  const split = splitSessionEvents(log);
  assert.equal(split.toolsMs, 0);
  assert.equal(split.thinkMs, 1000);
  assert.equal(split.turns, 1);
});

test('several rounds of one tool add up; other tools stay separate', () => {
  const log = [
    event('turn/start', 0),
    event('step/start', 0),
    event('assistant/message', 100),
    event('tool/call', 100, { ...callId('a'), name: 'workbuddy_relay' }),
    event('tool/result', 1100, resultFor('a')),
    event('step/start', 1100),
    event('assistant/message', 1200),
    event('tool/call', 1200, { ...callId('b'), name: 'workbuddy_review' }),
    event('tool/result', 3200, resultFor('b')),
    event('step/start', 3200),
    event('assistant/message', 3300),
    event('tool/call', 3300, { ...callId('c'), name: 'pwsh' }),
    event('tool/result', 4300, resultFor('c')),
  ].join('\n');

  const split = splitSessionEvents(log);
  assert.equal(split.workbuddyMs, 1000 + 2000);
  assert.equal(split.otherMs, 1000);
  assert.equal(split.turns, 1);
  assert.deepEqual(
    split.byTool.map((tool) => tool.name),
    ['workbuddy_review', 'workbuddy_relay', 'pwsh'],
  );
});

test('a missing log reports why instead of throwing', () => {
  const missing = summarizeSessionTime({ sessionId: 'session-does-not-exist' });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'no-session-log');
});

test('a corrupt file degrades gracefully', () => {
  const dir = scratch();
  const file = join(dir, 'session.v4.jsonl.zstd');
  writeFileSync(file, Buffer.from('not zstd at all'), 'utf8');
  const result = summarizeSessionTime({ file, fresh: true });
  assert.equal(result.available, false);
  assert.ok(['node-without-zstd', 'unreadable-log'].includes(result.reason), result.reason);
});

test(
  'multi-frame logs (one frame per append) are walked frame by frame',
  { skip: HAS_ZSTD ? false : 'Node < 22.15 has no zstd in node:zlib' },
  () => {
    const dir = scratch();
    const file = join(dir, 'session.v4.jsonl.zstd');
    // Two separate frames, exactly how DSH appends: decompressing only the first
    // one would yield 3s of thinking and lose the tool call entirely.
    const first = [
      event('turn/start', 0),
      event('step/start', 1000),
      event('assistant/message', 4000),
    ].join('\n');
    const second = [
      event('tool/call', 4100, { ...callId('c1'), name: 'workbuddy_relay' }),
      event('tool/result', 41_100, resultFor('c1')),
    ].join('\n');
    writeFileSync(
      file,
      Buffer.concat([zlib.zstdCompressSync(Buffer.from(first, 'utf8')), zlib.zstdCompressSync(Buffer.from(second, 'utf8'))]),
    );

    const result = summarizeSessionTime({ file, fresh: true, now: Date.now() });
    assert.equal(result.available, true);
    assert.equal(result.thinkMs, 3000);
    assert.equal(result.workbuddyMs, 37_000, 'the second frame must be read too');
  },
);

test(
  'an unchanged log is served from the cache; a changed one is re-read',
  { skip: HAS_ZSTD ? false : 'Node < 22.15 has no zstd in node:zlib' },
  () => {
    const dir = scratch();
    const file = join(dir, 'session.v4.jsonl.zstd');
    const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
    writeFileSync(file, frame([event('step/start', 0), event('assistant/message', 1000)].join('\n')));

    const now = Date.now();
    const first = summarizeSessionTime({ file, now });
    assert.equal(first.thinkMs, 1000);

    // Same file, second poll: same answer, and the result object is reused.
    const again = summarizeSessionTime({ file, now: now + 1000 });
    assert.equal(again, first, 'an unchanged file must not be re-inflated on every poll');

    // The file grows: the next poll must not serve the stale snapshot.
    writeFileSync(file, frame([event('step/start', 0), event('assistant/message', 9000)].join('\n')));
    const refreshed = summarizeSessionTime({ file, now: now + 2000 });
    assert.equal(refreshed.thinkMs, 9000);
  },
);

test('the panel payload carries the split, even when there is nothing to report', () => {
  // The client reads `timing` off the same poll as everything else; a wiring
  // mistake there would leave the panel row silently empty forever.
  const collabDir = scratch();
  const routes = new Map();
  const disposers = [];
  const ctx = {
    get: (service) =>
      service === 'webServer'
        ? {
            register: (route) => {
              routes.set(route.path, route.handler);
              return () => {};
            },
          }
        : undefined,
    on: () => () => {},
    set: () => {},
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    tools: { register: () => () => {} },
  };
  try {
    apply(ctx, { collabDir, cwd: home, watchMs: 60_000 });
    const handler = routes.get('/plugins/codebuddy-bridge/last-run');
    assert.equal(typeof handler, 'function', 'the last-run route must be registered');
    let body;
    handler(
      { url: '/plugins/codebuddy-bridge/last-run?sessionId=session-not-here', method: 'GET' },
      {
        statusCode: 0,
        setHeader: () => {},
        end: (text) => {
          body = JSON.parse(text);
        },
      },
    );
    assert.equal(typeof body.timing, 'object', 'timing must ride along with the poll');
    assert.equal(body.timing.available, false);
    assert.equal(body.timing.reason, 'no-session-log');
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
  for (const dir of temporary) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
  }
});
