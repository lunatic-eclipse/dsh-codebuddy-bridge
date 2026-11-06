// SPDX-License-Identifier: MIT
/**
 * Regression tests for the plan-scoring ledger.
 *
 * The ledger is the only thing that makes "was the collaboration worth it?" a
 * question with an answer instead of a feeling, so the parts that can be wrong
 * are pinned: score parsing, the arithmetic, and the cost-is-not-quality rule.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildReport,
  renderReport,
  parseScores,
  appendRecord,
  readRecords,
  main,
  DIMENSIONS,
} = await import('../tools/score.mjs');

const temporary = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-score-'));
  temporary.push(dir);
  return dir;
}

test('scores are five 1–5 integers, and anything else is refused', () => {
  assert.deepEqual(parseScores('4,3,5,4,4'), [4, 3, 5, 4, 4]);
  assert.equal(parseScores('1,1,1,1,1').length, DIMENSIONS.length);
  assert.throws(() => parseScores('4,3,5'), /需要 5 个值/);
  assert.throws(() => parseScores('4,3,5,4,6'), /1–5 的整数/);
  assert.throws(() => parseScores('4,3,5,4,4.5'), /1–5 的整数/);
  assert.throws(() => parseScores('a,b,c,d,e'), /1–5 的整数/);
});

test('the report averages per dimension and counts who won it', () => {
  const report = buildReport([
    { at: 1, task: 'A', self: [4, 3, 5, 4, 4], plan: [3, 2, 5, 3, 3], cost: 7, adopted: 'yes' },
    { at: 2, task: 'B', self: [2, 2, 4, 3, 2], plan: [5, 4, 4, 5, 5], cost: 11, adopted: 'no' },
  ]);

  assert.equal(report.count, 2);
  const executable = report.perDimension[0];
  assert.equal(executable.dimension, 'executable');
  assert.equal(executable.selfMean, 3);
  assert.equal(executable.planMean, 4);
  assert.equal(executable.planWins, 1);
  assert.equal(executable.selfWins, 1);

  assert.equal(report.overall.planWins, 1);
  assert.equal(report.overall.selfWins, 1);
  assert.equal(report.adopted.yes, 1);
  assert.equal(report.adopted.no, 1);
  assert.equal(report.cost.mean, 9);
});

test('cost is reported but never mixed into the score', () => {
  const report = buildReport([
    { at: 1, task: 'free', self: [3, 3, 3, 3, 3], plan: [3, 3, 3, 3, 3], cost: 0 },
    { at: 2, task: 'pricey', self: [3, 3, 3, 3, 3], plan: [3, 3, 3, 3, 3], cost: 30 },
  ]);
  assert.equal(report.overall.selfMeanTotal, 15);
  assert.equal(report.overall.planMeanTotal, 15);
  assert.equal(report.cost.total, 30);
  const text = renderReport(report);
  assert.match(text, /不参与打分/);
});

test('records survive a torn line and an empty file', () => {
  const dir = scratch();
  const file = join(dir, 'scores.jsonl');
  appendRecord(file, { at: 1, task: 'ok', self: [1, 1, 1, 1, 1], plan: [2, 2, 2, 2, 2] });
  writeFileSync(file, `${readFileSync(file, 'utf8')}{ not json\n`, 'utf8');
  const records = readRecords(file);
  assert.equal(records.length, 1, 'the torn line is skipped, the good one survives');
  assert.equal(records[0].task, 'ok');
  assert.deepEqual(readRecords(join(dir, 'nope.jsonl')), []);
});

test('a small sample says so out loud', () => {
  const report = buildReport([{ at: 1, task: 'one', self: [4, 4, 4, 4, 4], plan: [5, 5, 5, 5, 5] }]);
  const text = renderReport(report);
  assert.match(text, /样本只有 1 次/);
  assert.match(text, /别下结论/);
});

test('the CLI writes and reads the same ledger', () => {
  const dir = scratch();
  const added = main([
    'add',
    '--dir',
    dir,
    '--task',
    '要不要拆插件',
    '--score-self',
    '4,3,5,4,4',
    '--score-plan',
    '3,2,5,3,3',
    '--cost',
    '7.23',
    '--adopted',
    'yes',
  ]);
  assert.match(added, /已记录/);

  const records = readRecords(join(dir, 'scores.jsonl'));
  assert.equal(records.length, 1);
  assert.equal(records[0].task, '要不要拆插件');
  assert.equal(records[0].cost, 7.23);
  assert.equal(records[0].adopted, 'yes');

  const report = main(['report', '--dir', dir]);
  assert.match(report, /已打分 1 次/);
  assert.match(report, /照做 1/);
});

test('a bad --cost is rejected instead of silently becoming NaN', () => {
  const dir = scratch();
  assert.throws(
    () => main(['add', '--dir', dir, '--task', 'x', '--score-self', '1,1,1,1,1', '--score-plan', '1,1,1,1,1', '--cost', 'abc']),
    /--cost 必须是数字/,
  );
});

test('cost can be corrected afterwards, and the correction leaves a mark', () => {
  const dir = scratch();
  const add = (task, cost) =>
    main(['add', '--dir', dir, '--task', task, '--score-self', '4,3,4,3,3', '--score-plan', '4,4,5,4,4', '--cost', cost]);
  add('第一题', '18');
  add('第二题', '9');

  const out = main(['amend', '--dir', dir, '--cost', '16.98']);
  assert.match(out, /9 → 16\.98/, 'amend without --task targets the most recent record');

  const records = readRecords(join(dir, 'scores.jsonl'));
  assert.equal(records.length, 2, 'amending must not drop records');
  assert.equal(records[1].cost, 16.98, 'the last record is the one corrected');
  assert.equal(records[0].cost, 18, 'earlier records are untouched');
  assert.ok(typeof records[1].amendedAt === 'number', 'a correction is visible, not silent');

  // Target a specific entry instead of the last one.
  main(['amend', '--dir', dir, '--cost', '17.5', '--task', '第一题']);
  assert.equal(readRecords(join(dir, 'scores.jsonl'))[0].cost, 17.5);

  assert.throws(() => main(['amend', '--dir', dir]), /至少要给/);
  assert.throws(() => main(['amend', '--dir', dir, '--cost', '1', '--task', '不存在的题']), /没有可改的记录/);
});

test('task outcome is recorded separately from how good the plan read', () => {
  // The point of these fields: a plan can score well and the task still fail.
  const dir = scratch();
  const add = (task, extra) =>
    main(['add', '--dir', dir, '--task', task, '--score-self', '3,3,4,3,3', '--score-plan', '4,4,5,4,4', ...extra]);

  add('任务甲', ['--outcome', 'pass', '--rework', '1', '--minutes', '30']);
  add('任务乙', ['--outcome', 'fail', '--rework', '4', '--minutes', '90']);
  add('任务丙', []); // no outcome recorded yet

  const report = main(['report', '--dir', dir, '--json']);
  const parsed = JSON.parse(report);
  assert.equal(parsed.outcome.pass, 1);
  assert.equal(parsed.outcome.fail, 1);
  assert.equal(parsed.outcome.samples, 2, 'a record without an outcome must not count as a result');
  assert.equal(parsed.rework.mean, 2.5);
  assert.equal(parsed.minutes.mean, 60);

  const text = main(['report', '--dir', dir]);
  assert.match(text, /任务结果：通过 1 · 部分 0 · 未通过 1/);
  assert.match(text, /人工返工：均值 2\.5 次/);
  assert.match(text, /任务耗时：均值 60\.0 分钟/);
});

test('outcome rejects values that would quietly pollute the tally', () => {
  const dir = scratch();
  assert.throws(
    () => main(['add', '--dir', dir, '--task', 'x', '--score-self', '1,1,1,1,1', '--score-plan', '1,1,1,1,1', '--outcome', 'ok']),
    /--outcome 只能是/,
  );
  assert.throws(
    () => main(['add', '--dir', dir, '--task', 'x', '--score-self', '1,1,1,1,1', '--score-plan', '1,1,1,1,1', '--rework', '-2']),
    /--rework 必须是非负数字/,
  );
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
