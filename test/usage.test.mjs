// SPDX-License-Identifier: MIT
/**
 * Regression tests for the read-only usage report.
 *
 * The report must never invent numbers: the only two sources are how long a
 * round took (`runs.jsonl`) and the token counts the CLI wrote into its own
 * transcript. The trap this pins is session reuse — a reused CLI session's
 * transcript holds earlier rounds, so counting the whole file would double-count.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cbb-usage-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { summarizeUsage, renderUsageReport } = await import('../index.js');

const temporary = [home];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-usage-dir-'));
  temporary.push(dir);
  return dir;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 6, 5, 0, 0);

/** One transcript line carrying the CLI's own usage block. */
const usageLine = (ts, input, output, cache = 0) =>
  JSON.stringify({
    type: 'message',
    role: 'assistant',
    timestamp: ts,
    message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cache } },
  });

/** A runs.jsonl record; the transcript is written by the caller. */
const runRecord = ({ at, startedAt, file, sessionId, mode, summary }) =>
  JSON.stringify({
    at,
    roundStartedAt: startedAt,
    file,
    sessionId,
    summary: summary ?? 'done',
    ...(mode ? { mode } : {}),
  });

test('rounds are grouped by day and by mode, with wall time and tokens', () => {
  const dir = scratch();
  const t1 = NOW - 3 * HOUR;
  const t2 = NOW - 2 * HOUR;
  const t3 = NOW - 1 * HOUR;
  const f1 = join(dir, 'r1.jsonl');
  const f2 = join(dir, 'r2.jsonl');
  const f3 = join(dir, 'r3.jsonl');
  writeFileSync(f1, `${usageLine(t1 + 5000, 1000, 200)}\n`, 'utf8');
  writeFileSync(f2, `${usageLine(t2 + 5000, 2000, 400, 100)}\n`, 'utf8');
  writeFileSync(f3, `${usageLine(t3 + 5000, 3000, 600)}\n`, 'utf8');
  writeFileSync(
    join(dir, 'runs.jsonl'),
    [
      runRecord({ at: t1 + 10_000, startedAt: t1, file: f1, sessionId: 's1' }),
      runRecord({ at: t2 + 30_000, startedAt: t2, file: f2, sessionId: 's2', mode: 'plan' }),
      runRecord({ at: t3 + 120_000, startedAt: t3, file: f3, sessionId: 's3', mode: 'task' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const summary = summarizeUsage(dir, { now: NOW, days: 7 });
  assert.equal(summary.rounds.length, 3);
  assert.equal(summary.totals.rounds, 3);
  assert.equal(summary.totals.input, 6000);
  assert.equal(summary.totals.output, 1200);
  assert.equal(summary.totals.cacheRead, 100);
  assert.equal(summary.totals.durationMs, 10_000 + 30_000 + 120_000);
  assert.equal(summary.byDay.length, 1, 'all three rounds are on the same local day');
  assert.equal(summary.byDay[0][1].rounds, 3);

  const modes = Object.fromEntries(summary.byMode);
  assert.equal(modes.plan.rounds, 1);
  assert.equal(modes.task.rounds, 2);
  assert.equal(modes.plan.durationMs, 30_000);
  assert.equal(modes.plan.input, 2000);

  assert.equal(summary.duration.medianMs, 30_000);
  assert.equal(summary.duration.fastestMs, 10_000);
  assert.equal(summary.duration.slowestMs, 120_000);
});

test('a reused CLI session is not double-counted: tokens follow the round window', () => {
  const dir = scratch();
  const file = join(dir, 'shared.jsonl');
  const first = NOW - 5 * HOUR;
  const second = NOW - 4 * HOUR;
  // One file, two rounds: the earlier message must not leak into the later round.
  writeFileSync(
    file,
    `${[usageLine(first + 5000, 1111, 111), usageLine(second + 5000, 2222, 222)].join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'runs.jsonl'),
    [
      JSON.stringify({ at: first + 10_000, roundStartedAt: first, file, sessionId: 'shared', summary: 'one' }),
      JSON.stringify({ at: second + 10_000, roundStartedAt: second, file, sessionId: 'shared', summary: 'two' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const summary = summarizeUsage(dir, { now: NOW, days: 7 });
  assert.equal(summary.rounds.length, 2);
  assert.equal(summary.rounds[0].usage.input, 1111, 'first round only owns its own message');
  assert.equal(summary.rounds[1].usage.input, 2222);
  assert.equal(summary.totals.input, 3333, 'no double counting');
});

test('a missing transcript still counts the round, with zero tokens', () => {
  const dir = scratch();
  const at = NOW - HOUR;
  writeFileSync(
    join(dir, 'runs.jsonl'),
    `${JSON.stringify({ at, roundStartedAt: at - 60_000, file: join(dir, 'gone.jsonl'), sessionId: 'gone', summary: 'x' })}\n`,
    'utf8',
  );

  const summary = summarizeUsage(dir, { now: NOW, days: 7 });
  assert.equal(summary.rounds.length, 1);
  assert.equal(summary.rounds[0].usage, undefined);
  assert.equal(summary.totals.durationMs, 60_000);
  assert.match(renderUsageReport(summary), /1 轮 · 60 秒/);
});

test('the day window excludes older rounds', () => {
  const dir = scratch();
  const records = [];
  for (const [name, at] of [
    ['recent', NOW - HOUR],
    ['old', NOW - 10 * DAY],
  ]) {
    const file = join(dir, `${name}.jsonl`);
    writeFileSync(file, '', 'utf8');
    records.push(runRecord({ at, startedAt: at - 1000, file, sessionId: name }));
  }
  writeFileSync(join(dir, 'runs.jsonl'), `${records.join('\n')}\n`, 'utf8');

  assert.equal(summarizeUsage(dir, { now: NOW, days: 7 }).rounds.length, 1);
  assert.equal(summarizeUsage(dir, { now: NOW, days: 30 }).rounds.length, 2);
});

test('an empty exchange folder says so instead of printing zeros', () => {
  const dir = scratch();
  const text = renderUsageReport(summarizeUsage(dir, { now: NOW, days: 7 }));
  assert.match(text, /没有桥接轮次/);
  assert.doesNotMatch(text, /按天/);
});

test('the report never claims a credit figure', () => {
  const dir = scratch();
  const at = NOW - HOUR;
  const file = join(dir, 'one.jsonl');
  writeFileSync(file, `${usageLine(at - 30_000, 100, 10)}\n`, 'utf8');
  writeFileSync(
    join(dir, 'runs.jsonl'),
    `${JSON.stringify({ at, roundStartedAt: at - 60_000, file, sessionId: 'one', summary: 'x' })}\n`,
    'utf8',
  );
  const text = renderUsageReport(summarizeUsage(dir, { now: NOW, days: 7 }));
  assert.match(text, /不换算积分/);
  assert.doesNotMatch(text, /\d+(\.\d+)? *积分/);
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
