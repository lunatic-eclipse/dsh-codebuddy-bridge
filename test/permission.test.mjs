// SPDX-License-Identifier: MIT
/**
 * The default permission mode used to be `acceptEdits` while every document
 * said `dontAsk` — the one value that must never drift, because it decides
 * whether an unattended round parks on an approval prompt and dies. These tests
 * pin the default, the explicit override, and the per-call escape hatch.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cbb-perm-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { apply } = await import('../index.js');

const temporary = [home];
const disposers = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cbb-perm-dir-'));
  temporary.push(dir);
  return dir;
}

/** Mount the plugin against a throwaway exchange dir and hand back its tools. */
function mount(config = {}, enabledFor) {
  const collabDir = scratch();
  // The switches are read once, at mount time — writing the file afterwards
  // changes nothing in memory.
  writeFileSync(join(collabDir, 'modes.json'), JSON.stringify(enabledFor ? { [enabledFor]: true } : {}), 'utf8');
  const specs = new Map();
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
        specs.set(spec.name, spec);
        return () => {};
      },
    },
  };
  apply(ctx, { collabDir, cwd: home, watchMs: 60_000, ...config });
  return { spec: (name) => specs.get(name), collabDir };
}

test('the default mode is dontAsk', async () => {
  const { spec } = mount();
  const out = await spec('workbuddy_status').execute({}, { agent: { id: 'agent-perm' } });
  assert.match(out.text, /workbuddy_task）：dontAsk/, 'the direct path must default to dontAsk');
  assert.doesNotMatch(out.text, /workbuddy_task）：acceptEdits/);
});

test('status names the relay path separately, because that mode lives elsewhere', async () => {
  const { spec } = mount();
  const out = await spec('workbuddy_status').execute({}, { agent: { id: 'agent-perm' } });
  assert.match(out.text, /relay \/ review 走 \/codebuddy/, 'the relay mode is cliBridge config, not this one');
});

test('an explicit config still wins', async () => {
  const { spec } = mount({ permissionMode: 'acceptEdits' });
  const out = await spec('workbuddy_status').execute({}, { agent: { id: 'agent-perm' } });
  assert.match(out.text, /workbuddy_task）：acceptEdits/);
});

test('workbuddy_task takes a per-call mode and refuses an unknown one', async () => {
  const { spec } = mount({}, 'agent-perm');
  const task = spec('workbuddy_task');
  assert.equal(task.parameters.properties.permissionMode.enum.includes('acceptEdits'), true);
  await assert.rejects(
    () => task.execute({ prompt: 'x', permissionMode: 'acceptEverything' }, { agent: { id: 'agent-perm' } }),
    /不是合法值/,
  );
});

after(() => {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* cleanup must not mask a failure */
    }
  }
  for (const dir of temporary) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
  }
});
