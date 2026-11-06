// SPDX-License-Identifier: MIT
/**
 * Regression tests for failed rounds.
 *
 * A round that is cancelled, killed, or loses the host before its result comes
 * back used to leave *nothing* on disk: no runs.jsonl entry, no last-run.json.
 * Then "the task died halfway and may have edited files" is indistinguishable
 * from "nothing ever ran" — and a restart makes it worse. These tests pin the
 * trace, and pin that verify says "it failed" instead of "nothing to check".
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cbb-fail-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { apply } = await import('../index.js');

const temporary = [home];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-fail-dir-'));
  temporary.push(dir);
  return dir;
}

/** A bridge whose /codebuddy throws or returns an error, per option. */
function harness({ throws, errorText, summary, collabDir: given } = {}) {
  const collabDir = given ?? scratch();
  const agentId = 'agent-fail';
  writeFileSync(join(collabDir, 'modes.json'), `${JSON.stringify({ [agentId]: true })}\n`, 'utf8');
  const transcripts = join(home, '.codebuddy', 'projects', 'fail-proj');
  mkdirSync(transcripts, { recursive: true });

  const specs = [];
  const disposers = [];
  const calls = [];
  let counter = 0;

  const commands = {
    async execute(_agent, line) {
      calls.push(line);
      if (throws) throw new Error(throws);
      if (errorText) return { result: { kind: 'error', text: errorText } };
      counter += 1;
      const sessionId = `fail-sess-${counter}`;
      const now = Date.now();
      const rows = [
        { type: 'message', role: 'user', timestamp: now, cwd: home, content: [{ type: 'input_text', text: 'go' }] },
        {
          type: 'message',
          role: 'assistant',
          timestamp: now + 50,
          content: [{ type: 'output_text', text: summary ?? '做完了' }],
        },
      ];
      writeFileSync(join(transcripts, `${sessionId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      return { result: { kind: 'text', text: `ok session_id=${sessionId}` } };
    },
  };

  const ctx = {
    get: (service) => (service === 'commands' ? commands : undefined),
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

  apply(ctx, { collabDir, cwd: home, watchMs: 60_000 });

  return {
    collabDir,
    calls,
    runsFile: join(collabDir, 'runs.jsonl'),
    lastRunFile: join(collabDir, 'last-run.json'),
    execute: (name, args) => {
      const spec = specs.find((entry) => entry.name === name);
      assert.ok(spec, `${name} was not registered`);
      return spec.execute(args, { agent: { id: agentId } });
    },
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* cleanup must not mask the assertion */
        }
      }
    },
  };
}

// runs.jsonl is one JSON per line; last-run.json is one pretty-printed object.
const lastLine = (file) => JSON.parse(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).at(-1));
const wholeJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Same bridge on an existing exchange folder: what a restart looks like. */
const harnessOn = (collabDir) => harness({ collabDir });

test('a cancelled/killed relay round leaves a record instead of vanishing', async () => {
  const h = harness({ throws: 'cancelled by the host' });
  try {
    const out = await h.execute('workbuddy_relay', { prompt: '帮我改一下 a.js' });
    assert.match(out.text, /失败/);
    assert.equal(existsSync(h.runsFile), true, 'a failed round must still be recorded');
    const record = lastLine(h.runsFile);
    assert.equal(record.status, 'failed');
    assert.match(record.error, /cancelled by the host/);
    assert.match(record.prompt, /改一下 a\.js/);
    assert.equal(record.mode, 'task');
    assert.equal(existsSync(h.lastRunFile), true, 'the panel reads last-run.json, so it must know too');
    assert.match(wholeJson(h.lastRunFile).summary, /没跑完/);
  } finally {
    h.dispose();
  }
});

test('an engine error round is recorded with its mode and reason', async () => {
  const h = harness({ errorText: 'tool exploded on line 3' });
  try {
    const out = await h.execute('workbuddy_relay', { prompt: '先规划一下', mode: 'plan' });
    assert.match(out.text, /失败/);
    const record = lastLine(h.runsFile);
    assert.equal(record.status, 'failed');
    assert.equal(record.mode, 'plan');
    assert.match(record.error, /tool exploded/);
  } finally {
    h.dispose();
  }
});

test('a quota rejection is not a failure: nothing is written', async () => {
  const h = harness({ errorText: 'rate limit exceeded, retry after 30' });
  try {
    const out = await h.execute('workbuddy_relay', { prompt: '再来一轮' });
    assert.equal(out.rejected, true);
    assert.equal(existsSync(h.runsFile), false, 'a quota cooldown is a refusal, not a failed round');
  } finally {
    h.dispose();
  }
});

test('verify explains a failed round instead of denying it exists', async () => {
  const h = harness({ throws: 'cancelled by the host' });
  try {
    await h.execute('workbuddy_relay', { prompt: '改 settings.json' });
    const check = await h.execute('workbuddy_verify', { run: 1 });
    assert.match(check.text, /没跑完/);
    assert.match(check.text, /cancelled by the host/);
    assert.match(check.text, /可能已经改了一部分文件/);
    assert.doesNotMatch(check.text, /没有可核对的轮次/);
  } finally {
    h.dispose();
  }
});

test('a successful round is still a normal record (no status field)', async () => {
  const h = harness({ summary: '改完了 a.js' });
  try {
    await h.execute('workbuddy_relay', { prompt: '改一下 a.js' });
    const record = lastLine(h.runsFile);
    assert.equal(record.status, undefined, 'only failures carry status=failed');
    assert.ok(record.file, 'a successful round carries its transcript');
  } finally {
    h.dispose();
  }
});

test('a round that was in flight when the host died is recovered as failed', () => {
  // The process that would have written the result is gone, so the only evidence
  // is the marker written before the CLI was called.
  const collabDir = scratch();
  const startedAt = Date.now() - 5 * 60_000;
  writeFileSync(
    join(collabDir, 'pending.json'),
    `${JSON.stringify(
      { [`${process.pid}`]: { at: startedAt, roundStartedAt: startedAt, mode: 'task', prompt: '改 config.js' } },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const h = harnessOn(collabDir);
  try {
    const record = lastLine(join(collabDir, 'runs.jsonl'));
    assert.equal(record.status, 'failed');
    assert.match(record.error, /收尾之前退出/);
    assert.equal(record.roundStartedAt, startedAt);
    assert.match(record.prompt, /改 config\.js/);
    assert.equal(wholeJson(join(collabDir, 'pending.json'))['' + process.pid], undefined, 'the marker is consumed');
  } finally {
    h.dispose();
  }
});

test('a marker that was followed by a finished round is not reported as a crash', async () => {
  const h = harness({ summary: '改完了 a.js' });
  const collabDir = h.collabDir;
  try {
    await h.execute('workbuddy_relay', { prompt: '改一下 a.js' });
    // The marker from that round is still on disk (it is never cleared eagerly).
    assert.ok(wholeJson(join(collabDir, 'pending.json'))['' + process.pid], 'marker written before the CLI call');
  } finally {
    h.dispose();
  }

  // Booting on the same folder must not invent a failure for a round that finished.
  const before = readFileSync(join(collabDir, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  const again = harnessOn(collabDir);
  try {
    const after = readFileSync(join(collabDir, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
    assert.equal(after, before, 'a completed round must not be re-reported as a crash');
  } finally {
    again.dispose();
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
