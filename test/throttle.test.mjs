// SPDX-License-Identifier: MIT
/**
 * Regression tests for the round throttle (0.3 M3).
 *
 * The gate exists to stop "retry until it works" from burning a whole evening of
 * relay quota in one session, so the tests pin the parts a user can be hurt by:
 * the 7th round is refused, the countdown only ever shrinks, a refused round
 * reaches neither the CLI nor runs.jsonl, the count survives a restart, and a
 * relay-reported quota cooldown wins over the local window.
 *
 * Time is injected everywhere the throttle decides (`now`), so no test waits on
 * a real hour; the one test that must cross a real window uses a 1.2s window.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// index.js resolves the CLI transcript store from USERPROFILE at import time.
const home = mkdtempSync(join(tmpdir(), 'cbb-throttle-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { checkRound, setQuotaCooldown, parseCooldownSeconds, readQuotaFailure, apply, ROUND_LIMIT, ROUND_WINDOW_MS } =
  await import('../index.js');

const T0 = Date.UTC(2026, 10, 6, 4, 0, 0);
const temporary = [home];

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-limit-'));
  temporary.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lineCount = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length : 0);

/** A DSH-shaped context whose `commands.execute` behaves like /codebuddy. */
function harness({ roundLimit, roundWindowMs, quota, failure } = {}) {
  const collabDir = scratchDir();
  const agentId = 'agent-throttle';
  writeFileSync(join(collabDir, 'modes.json'), `${JSON.stringify({ [agentId]: true })}\n`, 'utf8');
  const transcripts = join(home, '.codebuddy', 'projects', 'throttle-proj');
  mkdirSync(transcripts, { recursive: true });

  const specs = [];
  const disposers = [];
  const calls = [];
  let counters = 0;

  // The transcript must exist before the relay records the round: recordRun is
  // what appends runs.jsonl, and that is one of the assertions below.
  const commands = {
    async execute(_agent, line) {
      calls.push(line);
      if (typeof quota === 'string') return { result: { kind: 'error', text: quota } };
      if (typeof failure === 'string') return { result: { kind: 'error', text: failure } };
      counters += 1;
      const sessionId = `sess-${Date.now()}-${counters}`;
      writeFileSync(
        join(transcripts, `${sessionId}.jsonl`),
        `${JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: Date.now(),
          content: [{ type: 'output_text', text: '看完了' }],
        })}\n`,
        'utf8',
      );
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

  apply(ctx, {
    collabDir,
    cwd: home,
    watchMs: 60_000,
    ...(roundLimit ? { roundLimit } : {}),
    ...(roundWindowMs ? { roundWindowMs } : {}),
  });

  return {
    collabDir,
    agentId,
    calls,
    runsFile: join(collabDir, 'runs.jsonl'),
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

test('the seventh round in one window is refused, and its countdown only shrinks', () => {
  const file = join(scratchDir(), 'limits.json');
  const sessionId = 'ds-session-1';

  for (let round = 1; round <= ROUND_LIMIT; round += 1) {
    const verdict = checkRound({ file, sessionId, now: T0 + round * 1000, consume: true });
    assert.equal(verdict.allowed, true, `round ${round} should be admitted`);
    assert.equal(verdict.used, round);
    assert.equal(verdict.limit, ROUND_LIMIT);
  }

  const refused = checkRound({ file, sessionId, now: T0 + 7000, consume: true });
  assert.equal(refused.allowed, false);
  assert.equal(refused.rejected, true);
  assert.equal(refused.reason, 'window');
  assert.equal(refused.used, ROUND_LIMIT, 'a refused round must not be counted');
  // The window starts at the first counted round, so ~1h minus the 6s already spent.
  assert.ok(refused.retryAfterSec > 3500 && refused.retryAfterSec <= 3600, `got ${refused.retryAfterSec}s`);

  let previous = refused.retryAfterSec;
  for (let step = 1; step <= 5; step += 1) {
    const later = checkRound({ file, sessionId, now: T0 + 7000 + step * 60_000, consume: true });
    assert.equal(later.allowed, false);
    assert.ok(later.retryAfterSec < previous, 'retryAfterSec must strictly decrease while refused');
    assert.ok(later.retryAfterSec > 0, 'a refusal always carries a positive wait');
    previous = later.retryAfterSec;
  }

  const reopened = checkRound({ file, sessionId, now: T0 + ROUND_WINDOW_MS + 7000, consume: true });
  assert.equal(reopened.allowed, true, 'the window must reset after an hour');
  assert.equal(reopened.used, 1);
  assert.equal(reopened.remaining, ROUND_LIMIT - 1);
});

test('sessions are counted apart, and a corrupt ledger means "no counts yet"', () => {
  const file = join(scratchDir(), 'limits.json');
  for (let round = 0; round < ROUND_LIMIT; round += 1) {
    checkRound({ file, sessionId: 'busy', now: T0 + round, consume: true });
  }
  assert.equal(checkRound({ file, sessionId: 'busy', now: T0 + 100 }).allowed, false);
  assert.equal(checkRound({ file, sessionId: 'other', now: T0 + 100 }).allowed, true);

  writeFileSync(file, '{ this is not json', 'utf8');
  const recovered = checkRound({ file, sessionId: 'busy', now: T0 + 200, consume: true });
  assert.equal(recovered.allowed, true, 'garbage must degrade to an empty ledger, not to a crash');
  assert.equal(recovered.used, 1);
});

test("relay's own cooldown outranks the local window and does not wipe its count", () => {
  const file = join(scratchDir(), 'limits.json');
  const sessionId = 'ds-quota';
  checkRound({ file, sessionId, now: T0, consume: true });

  const cooldown = setQuotaCooldown({ file, sessionId, seconds: 120, now: T0 + 2000 });
  assert.equal(cooldown.retryAfterSec, 120);

  const blocked = checkRound({ file, sessionId, now: T0 + 3000, consume: true });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'quota');
  assert.equal(blocked.retryAfterSec, 119);

  const stillBlocked = checkRound({ file, sessionId, now: T0 + 63_000 });
  assert.equal(stillBlocked.retryAfterSec, 59);

  const reopened = checkRound({ file, sessionId, now: T0 + 122_000 + 1000, consume: true });
  assert.equal(reopened.allowed, true);
  assert.equal(reopened.used, 2, 'the cooldown pauses rounds; it does not refund the window');
});

test('cooldown parsing handles the shapes an engine actually prints', () => {
  const cases = [
    ['rate limit exceeded, retry after 30', 30],
    ['429 Too Many Requests; Retry-After: 45s', 45],
    ['请求过于频繁，请 90 秒后重试', 90],
    ['额度不足，冷却 5 分钟', 300],
    ['quota exhausted, retry in 2 hours', 7200],
    ['too many requests', undefined],
    ['Write failed: EACCES', undefined],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parseCooldownSeconds(text), expected, `parseCooldownSeconds(${JSON.stringify(text)})`);
  }

  assert.equal(readQuotaFailure('rate limit exceeded, retry after 30').retryAfterSec, 30);
  assert.equal(readQuotaFailure('rate limit exceeded, retry after 30').explicit, true);
  assert.equal(readQuotaFailure('too many requests').retryAfterSec, 300, 'no number → conservative default');
  assert.equal(readQuotaFailure('too many requests').explicit, false);
  assert.equal(readQuotaFailure('Write failed: EACCES'), undefined, 'an ordinary failure is not a quota trip');
  assert.equal(readQuotaFailure(''), undefined);
});

test('the relay refuses the 7th round without touching the CLI or runs.jsonl', async () => {
  const h = harness();
  try {
    for (let round = 1; round <= ROUND_LIMIT; round += 1) {
      const out = await h.execute('workbuddy_relay', { prompt: `第 ${round} 轮` });
      assert.equal(out.rejected, undefined, `round ${round} should not be refused: ${out.text}`);
      assert.ok(out.text.includes(`还剩 ${ROUND_LIMIT - round}/${ROUND_LIMIT} 轮`), out.text);
    }
    assert.equal(h.calls.length, ROUND_LIMIT);
    assert.equal(lineCount(h.runsFile), ROUND_LIMIT, 'the admitted rounds must actually be recorded');

    const callsBefore = h.calls.length;
    const runsBefore = lineCount(h.runsFile);
    const refused = await h.execute('workbuddy_relay', { prompt: '第 7 轮' });
    assert.equal(refused.rejected, true);
    assert.equal(Number.isInteger(refused.retryAfterSec), true);
    assert.ok(refused.retryAfterSec > 0 && refused.retryAfterSec <= 3600, `got ${refused.retryAfterSec}`);
    assert.match(refused.text, /节流/);
    assert.equal(h.calls.length, callsBefore, 'a refused round must not reach the CLI');
    assert.equal(lineCount(h.runsFile), runsBefore, 'a refused round must not add a run record');

    // The review path shares the same allowance — it costs the same round.
    const reviewRefused = await h.execute('workbuddy_review', { path: 'a.js' });
    assert.equal(reviewRefused.rejected, true);
    assert.equal(h.calls.length, callsBefore, 'the review path must be refused too');
  } finally {
    h.dispose();
  }
});

test('the count survives a restart, so reopening DSH does not refill the window', async () => {
  const first = harness();
  const collabDir = first.collabDir;
  try {
    for (let round = 1; round <= ROUND_LIMIT; round += 1) {
      await first.execute('workbuddy_relay', { prompt: `第 ${round} 轮` });
    }
    assert.equal((await first.execute('workbuddy_relay', { prompt: '第 7 轮' })).rejected, true);
  } finally {
    first.dispose();
  }

  // A second plugin instance on the same exchange folder is what a restart looks
  // like: nothing survives in memory, the ledger on disk has to carry the count.
  const reloaded = harnessOn(collabDir);
  try {
    const out = await reloaded.execute('workbuddy_relay', { prompt: '重启后再派' });
    assert.equal(out.rejected, true, 'a restart must not forget the spent window');
    assert.equal(reloaded.calls.length, 0, 'the refused round must not reach the CLI');
  } finally {
    reloaded.dispose();
  }
});

/** Same harness, but on an existing exchange folder (a restart, not a new machine). */
function harnessOn(collabDir) {
  const agentId = 'agent-throttle';
  const specs = [];
  const disposers = [];
  const calls = [];
  const commands = {
    async execute(_agent, line) {
      calls.push(line);
      return { result: { kind: 'text', text: 'ok session_id=sess-restart' } };
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
    calls,
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

test('a relay quota error reports relay\'s cooldown, and then refuses locally', async () => {
  const h = harness({ quota: 'API rate limit exceeded, please retry after 42s' });
  try {
    const out = await h.execute('workbuddy_relay', { prompt: '给我写个总结' });
    assert.equal(out.rejected, true);
    assert.equal(out.retryAfterSec, 42, 'the engine cooldown wins over the local window');
    assert.match(out.text, /额度|限流/);

    const callsBefore = h.calls.length;
    const blocked = await h.execute('workbuddy_relay', { prompt: '再试一次' });
    assert.equal(blocked.rejected, true);
    assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 42, `got ${blocked.retryAfterSec}`);
    assert.equal(h.calls.length, callsBefore, 'while cooling down nothing is sent to the CLI');
  } finally {
    h.dispose();
  }
});

test('an ordinary engine failure is reported as a failure, not as a quota trip', async () => {
  const h = harness({ failure: 'Write failed: EACCES' });
  try {
    const out = await h.execute('workbuddy_relay', { prompt: '改一下 a.js' });
    assert.equal(out.rejected, undefined);
    assert.match(out.text, /失败/);
    assert.doesNotMatch(out.text, /冷却/);
  } finally {
    h.dispose();
  }
});

test('after a real (short) window the tool admits rounds again and the wait counts down', async () => {
  const h = harness({ roundLimit: 2, roundWindowMs: 1200 });
  try {
    assert.equal((await h.execute('workbuddy_relay', { prompt: '一' })).rejected, undefined);
    assert.equal((await h.execute('workbuddy_relay', { prompt: '二' })).rejected, undefined);

    const refused = await h.execute('workbuddy_relay', { prompt: '三' });
    assert.equal(refused.rejected, true);
    assert.ok(refused.retryAfterSec >= 1 && refused.retryAfterSec <= 2, `got ${refused.retryAfterSec}`);

    await sleep(1300);
    const reopened = await h.execute('workbuddy_relay', { prompt: '四' });
    assert.equal(reopened.rejected, undefined);
    assert.equal(h.calls.length, 3);
  } finally {
    h.dispose();
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
