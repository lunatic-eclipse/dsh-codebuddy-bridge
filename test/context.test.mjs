// SPDX-License-Identifier: MIT
/**
 * The context brief is how a brand-new session learns this plugin without the
 * user re-explaining it, so two things must hold: the file is found from the
 * installed plugin directory (not the cwd), and the tool is actually registered
 * with a name a model can pick.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cbb-ctx-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { apply, readContextBrief } = await import('../index.js');

const temporary = [home];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-ctx-dir-'));
  temporary.push(dir);
  return dir;
}

test('the brief is read from the plugin folder, not the working directory', () => {
  const brief = readContextBrief();
  assert.match(brief, /外脑/, 'the division of labour must be stated');
  assert.match(brief, /dontAsk/, 'the permission-mode trap must be stated');
  assert.match(brief, /7–27 积分/, 'the cost range must be stated');
  assert.doesNotMatch(brief, /找不到 docs/, 'the file must exist in the installed plugin');
});

test('the tool is registered and returns the same brief', async () => {
  const collabDir = scratch();
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
  try {
    writeFileSync(join(collabDir, 'modes.json'), '{}\n', 'utf8');
    apply(ctx, { collabDir, cwd: home, watchMs: 60_000 });
    const spec = specs.find((entry) => entry.name === 'workbuddy_context');
    assert.ok(spec, 'workbuddy_context must be registered');
    assert.match(spec.description, /第一次/, 'the description has to say when to call it');
    const out = await spec.execute({}, { agent: { id: 'agent-ctx' } });
    assert.match(out.text, /外脑/);
    assert.equal(out.text, readContextBrief());
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
