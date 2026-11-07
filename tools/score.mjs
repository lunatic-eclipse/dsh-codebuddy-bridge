#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Score one question answered twice: once by DSH alone, once with WorkBuddy.
 *
 * The comparison only means something when the order is fixed — write our own
 * answer *before* asking WorkBuddy, otherwise its framing leaks into ours. This
 * script does not enforce that; it records enough (two file paths, five scores,
 * cost, whether the advice was adopted) that the order cannot be quietly
 * re-arranged afterwards.
 *
 * Five dimensions, each 1–5, deliberately blunt:
 *   executable     第一步今天能不能动手
 *   counterfactual 反例说的是失效条件，还是泛泛的"注意风险"
 *   honesty        不知道的标了没有，有没有编造本项目的细节
 *   density        删掉客套话还剩多少
 *   wouldFollow    我会不会照做（最直接的一票）
 *
 * Anti-gaming: cost is recorded but never folded into the score. A free plan
 * must not look better than a paid one on the quality dimensions.
 *
 * Usage:
 *   node tools/score.mjs add --task "..." --self <file> --plan <file> \
 *        --score-self 4,3,5,4,4 --score-plan 3,2,5,3,3 [--cost 7.23] [--adopted yes|partial|no] [--note "..."]
 *   node tools/score.mjs report [--dir <exchange dir>] [--json]
 *
 * Records live in <exchange dir>/scores.jsonl (default ~/.dsh/codebuddy-bridge).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const DIMENSIONS = ['executable', 'counterfactual', 'honesty', 'density', 'wouldFollow'];
export const DIMENSION_LABELS = {
  executable: '可执行性',
  counterfactual: '反例质量',
  honesty: '信息诚实',
  density: '信息密度',
  wouldFollow: '我会照做',
};

export function defaultStore() {
  return join(homedir(), '.dsh', 'codebuddy-bridge', 'scores.jsonl');
}

/** "4,3,5,4,4" → [4,3,5,4,4]; refuses anything that is not five 1–5 integers. */
export function parseScores(text, label = '分数') {
  const parts = String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== DIMENSIONS.length) {
    throw new Error(`${label}需要 ${DIMENSIONS.length} 个值、用逗号分隔，收到 ${parts.length} 个`);
  }
  const scores = parts.map((part) => Number(part));
  for (const [index, score] of scores.entries()) {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error(`${label}第 ${index + 1} 个值必须是 1–5 的整数，收到 "${parts[index]}"`);
    }
  }
  return scores;
}

export function appendRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function readRecords(file) {
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a torn line must not hide the rest */
    }
  }
  return records;
}

export function rewriteRecords(file, records) {
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  return records.length;
}

/**
 * Costs cannot be known when the round ends — they come from a balance delta the
 * user reads afterwards. Amending keeps that honest: the ledger is append-only by
 * default, and a correction is explicit rather than a silent re-write.
 */
export function amendRecord(file, { match, changes }) {
  const records = readRecords(file);
  const index = records.findLastIndex((record) => match(record));
  if (index === -1) return undefined;
  const before = records[index];
  records[index] = { ...before, ...changes, amendedAt: Date.now() };
  rewriteRecords(file, records);
  return { before, after: records[index] };
}

const mean = (values) => (values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length);

export function buildReport(records) {
  const rows = records.map((record) => {
    const self = Array.isArray(record.self) ? record.self : [];
    const plan = Array.isArray(record.plan) ? record.plan : [];
    return {
      task: record.task ?? '（未写）',
      at: record.at,
      self,
      plan,
      selfTotal: self.reduce((a, b) => a + b, 0),
      planTotal: plan.reduce((a, b) => a + b, 0),
      cost: typeof record.cost === 'number' ? record.cost : undefined,
      adopted: record.adopted ?? 'unknown',
      note: record.note ?? '',
      // Task-level outcome, not plan-level quality. A plan can read well and the
      // task still fail; keeping both is the whole point of the ledger.
      outcome: record.outcome ?? undefined,
      rework: typeof record.rework === 'number' ? record.rework : undefined,
      minutes: typeof record.minutes === 'number' ? record.minutes : undefined,
    };
  });

  // Not every record is a two-plan comparison: a task has an outcome and no
  // plan to score. Those rows must not be counted as 0:0 ties — that would
  // quietly rewrite the win/tie record while looking like extra data.
  const scored = rows.filter(
    (row) => row.self.length === DIMENSIONS.length && row.plan.length === DIMENSIONS.length,
  );

  const perDimension = DIMENSIONS.map((dimension, index) => {
    const self = scored.map((row) => row.self[index]).filter((value) => typeof value === 'number');
    const plan = scored.map((row) => row.plan[index]).filter((value) => typeof value === 'number');
    const planWins = scored.filter((row) => row.plan[index] > row.self[index]).length;
    const selfWins = scored.filter((row) => row.self[index] > row.plan[index]).length;
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      selfMean: mean(self),
      planMean: mean(plan),
      planWins,
      selfWins,
      ties: scored.length - planWins - selfWins,
    };
  });

  const planWinsOverall = scored.filter((row) => row.planTotal > row.selfTotal).length;
  const selfWinsOverall = scored.filter((row) => row.selfTotal > row.planTotal).length;
  const costs = rows.map((row) => row.cost).filter((value) => typeof value === 'number');

  return {
    count: rows.length,
    scored: scored.length,
    taskOnly: rows.length - scored.length,
    rows,
    perDimension,
    overall: {
      planWins: planWinsOverall,
      selfWins: selfWinsOverall,
      ties: scored.length - planWinsOverall - selfWinsOverall,
      selfMeanTotal: mean(scored.map((row) => row.selfTotal)),
      planMeanTotal: mean(scored.map((row) => row.planTotal)),
    },
    cost: {
      mean: mean(costs),
      total: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined,
      samples: costs.length,
    },
    outcome: {
      pass: rows.filter((row) => row.outcome === 'pass').length,
      partial: rows.filter((row) => row.outcome === 'partial').length,
      fail: rows.filter((row) => row.outcome === 'fail').length,
      samples: rows.filter((row) => typeof row.outcome === 'string').length,
    },
    rework: {
      mean: mean(rows.map((row) => row.rework).filter((value) => typeof value === 'number')),
      samples: rows.filter((row) => typeof row.rework === 'number').length,
    },
    minutes: {
      mean: mean(rows.map((row) => row.minutes).filter((value) => typeof value === 'number')),
      samples: rows.filter((row) => typeof row.minutes === 'number').length,
    },
    adopted: {
      yes: rows.filter((row) => row.adopted === 'yes').length,
      partial: rows.filter((row) => row.adopted === 'partial').length,
      no: rows.filter((row) => row.adopted === 'no').length,
    },
  };
}

const fmt = (value, digits = 2) => (typeof value === 'number' ? value.toFixed(digits) : '—');

export function renderReport(report) {
  if (report.count === 0) return '还没有打过分。先跑 node tools/score.mjs add --help 看用法。';
  const lines = [
    report.taskOnly > 0
      ? `已打分 ${report.scored} 次 · 另有 ${report.taskOnly} 条只记任务层（不参与计划层均值与胜负）`
      : `已打分 ${report.count} 次`,
    '',
    `维度        DSH 自己   WorkBuddy   WorkBuddy 赢 / 自己赢 / 平`,
  ];
  for (const row of report.perDimension) {
    lines.push(
      `${row.label.padEnd(6, '　')}  ${fmt(row.selfMean, 1).padStart(6)}  ${fmt(row.planMean, 1).padStart(9)}      ${row.planWins} / ${row.selfWins} / ${row.ties}`,
    );
  }
  lines.push('');
  lines.push(
    `总分均值    ${fmt(report.overall.selfMeanTotal, 1).padStart(6)}  ${fmt(report.overall.planMeanTotal, 1).padStart(9)}      ${report.overall.planWins} / ${report.overall.selfWins} / ${report.overall.ties}`,
  );
  lines.push(
    `采纳情况：照做 ${report.adopted.yes} · 部分 ${report.adopted.partial} · 没照做 ${report.adopted.no}`,
  );
  lines.push(
    report.outcome.samples > 0
      ? `任务结果：通过 ${report.outcome.pass} · 部分 ${report.outcome.partial} · 未通过 ${report.outcome.fail}（${report.outcome.samples} 次有记录）`
      : '任务结果：还没记（--outcome pass|partial|fail）',
  );
  lines.push(
    report.rework.samples > 0
      ? `人工返工：均值 ${fmt(report.rework.mean, 1)} 次（${report.rework.samples} 次有记录）`
      : '人工返工：还没记（--rework N）',
  );
  lines.push(
    report.minutes.samples > 0
      ? `任务耗时：均值 ${fmt(report.minutes.mean, 1)} 分钟（${report.minutes.samples} 次有记录）`
      : '任务耗时：还没记（--minutes N）',
  );
  lines.push(
    report.cost.samples > 0
      ? `成本：${report.cost.samples} 次共 ${fmt(report.cost.total, 2)} 积分（均值 ${fmt(report.cost.mean, 2)}）——只作参考，不参与打分`
      : '成本：还没记',
  );
  if (report.scored < 5) lines.push('');
  if (report.scored < 5) lines.push(`样本只有 ${report.scored} 次，别下结论；到 5 次以上再看趋势。`);
  return lines.join('\n');
}

const USAGE = `用法：
  node tools/score.mjs add --task "问题" --self plans/self-x.md --plan plans/y.md \\
       --score-self 4,3,5,4,4 --score-plan 3,2,5,3,3 [--cost 7.23] [--adopted yes|partial|no] \\
       [--outcome pass|partial|fail] [--rework N] [--minutes N] [--note "..."]

  node tools/score.mjs add --task "做成了什么" --outcome pass|partial|fail \\
       [--rework N] [--minutes N] [--cost N] [--note "..."]        # 只记任务层

  node tools/score.mjs report [--dir <交换目录>] [--json]
  node tools/score.mjs amend --cost 16.98 [--task <关键词>] [--note "..."] [--adopted yes|partial|no] \\
       [--outcome pass|partial|fail] [--rework N] [--minutes N]

--outcome / --rework / --minutes 是**任务层**的字段，不是计划层的：
计划写得漂亮而任务照样失败，正是这张账要能看见的事。
没有第二份计划可比时可以不打分（只给 --outcome）：这种记录只进任务层统计，
不参与计划层的均值与胜负——否则它会变成一条 0:0 的"平"。

amend 改的是**最近一条**（给了 --task 就改最近一条 task 含该关键词的）：
积分是轮次结束后从余额差值读到的，事后修正属正常，但会留 amendedAt。

维度顺序：${DIMENSIONS.map((d) => `${DIMENSION_LABELS[d]}`).join(' / ')}（各 1–5 分）
分数例子：--score-self 4,3,5,4,4 表示 可执行4/反例3/诚实5/密度4/照做4`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

const OUTCOMES = ['pass', 'partial', 'fail'];

/** Task-level fields: a plan can read well while the task still fails. */
function outcomeChanges(args) {
  const changes = {};
  if (args.outcome !== undefined) {
    if (!OUTCOMES.includes(args.outcome)) {
      throw new Error(`--outcome 只能是 ${OUTCOMES.join(' / ')}，收到 "${args.outcome}"`);
    }
    changes.outcome = args.outcome;
  }
  for (const [flag, key] of [
    ['rework', 'rework'],
    ['minutes', 'minutes'],
  ]) {
    if (args[flag] === undefined) continue;
    const value = Number(args[flag]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${flag} 必须是非负数字，收到 "${args[flag]}"`);
    changes[key] = value;
  }
  return changes;
}

export function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const store = typeof args.dir === 'string' ? join(args.dir, 'scores.jsonl') : defaultStore();

  if (command === 'add') {
    if (args.help === true) return USAGE;
    // "Did the task work" is a different question from "which draft read
    // better". Forcing ten scores onto a record that has no second draft would
    // mean inventing them, and a fake 0:0 row silently becomes a tie in the
    // win/loss column. So: both score sets, or none plus an outcome.
    const hasSelf = args['score-self'] !== undefined;
    const hasPlan = args['score-plan'] !== undefined;
    if (hasSelf !== hasPlan) {
      throw new Error('--score-self 和 --score-plan 要一起给，或者都不给（只记任务层）');
    }
    if (!hasSelf && args.outcome === undefined) {
      throw new Error('不带分数的记录必须给 --outcome pass|partial|fail，否则这条记录没有内容');
    }
    const record = {
      at: Date.now(),
      task: typeof args.task === 'string' ? args.task : '（未写）',
      ...(hasSelf
        ? {
            self: parseScores(args['score-self'], 'DSH 自己的'),
            plan: parseScores(args['score-plan'], 'WorkBuddy 的'),
          }
        : {}),
      selfFile: typeof args.self === 'string' ? args.self : undefined,
      planFile: typeof args.plan === 'string' ? args.plan : undefined,
      ...(args.cost !== undefined ? { cost: Number(args.cost) } : {}),
      ...(typeof args.adopted === 'string' ? { adopted: args.adopted } : {}),
      ...(typeof args.note === 'string' ? { note: args.note } : {}),
      ...outcomeChanges(args),
    };
    if (record.cost !== undefined && !Number.isFinite(record.cost)) throw new Error(`--cost 必须是数字，收到 "${args.cost}"`);
    appendRecord(store, record);
    if (!hasSelf) {
      return [
        `已记录（任务层）：${record.task}`,
        `结果：${record.outcome}${record.rework !== undefined ? ` · 返工 ${record.rework} 次` : ''}${record.minutes !== undefined ? ` · ${record.minutes} 分钟` : ''}`,
        `存到：${store}`,
      ].join('\n');
    }
    return `已记录：${record.task}\n分数：自己 [${record.self.join(',')}] · WorkBuddy [${record.plan.join(',')}]\n存到：${store}`;
  }

  if (command === 'amend') {
    // The balance delta arrives after the fact; correcting it must be explicit.
    const changes = { ...outcomeChanges(args) };
    if (args.cost !== undefined) {
      const cost = Number(args.cost);
      if (!Number.isFinite(cost)) throw new Error(`--cost 必须是数字，收到 "${args.cost}"`);
      changes.cost = cost;
    }
    if (typeof args.note === 'string') changes.note = args.note;
    if (typeof args.adopted === 'string') changes.adopted = args.adopted;
    if (Object.keys(changes).length === 0) {
      throw new Error('amend 至少要给 --cost / --note / --adopted / --outcome / --rework / --minutes 之一');
    }
    const taskFilter = typeof args.task === 'string' ? args.task : undefined;
    const result = amendRecord(store, {
      match: (record) => (taskFilter === undefined ? true : String(record.task ?? '').includes(taskFilter)),
      changes,
    });
    if (!result) throw new Error(`账本里没有可改的记录${taskFilter ? `（task 含 "${taskFilter}"）` : ''}`);
    return `已修正：${result.after.task}\n成本：${result.before.cost ?? '—'} → ${result.after.cost ?? '—'}\n存到：${store}`;
  }

  if (command === 'report' || command === 'list') {
    const report = buildReport(readRecords(store));
    return args.json === true ? JSON.stringify(report, null, 2) : renderReport(report);
  }

  return USAGE;
}

// Only run when executed directly (tests import the functions instead).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`错了：${error instanceof Error ? error.message : String(error)}`);
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
  }
}
