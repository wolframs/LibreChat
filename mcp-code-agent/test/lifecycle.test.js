import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worktrees, gitAt, dirtyAt, headAt } from '../worktrees.js';
import { Engine } from '../engine.js';
import { completion, runSession } from '../session.js';
import { acquireLock } from '../lock.js';
import { applicationPlan } from '../deployment.js';

const ID = '1234567890abcdef12345678';
const SECOND = 'abcdef1234567890abcdef12';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'operator checkout');
  await fs.mkdir(repo);
  await gitAt(repo, ['init', '-b', 'local-features']);
  await gitAt(repo, ['config', 'user.name', 'Test operator']);
  await gitAt(repo, ['config', 'user.email', 'operator@example.test']);
  await fs.mkdir(path.join(repo, 'client'));
  await fs.writeFile(path.join(repo, 'client/feature.js'), 'export const feature = 1;\n');
  await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\nprivate.local\n.env\n');
  await gitAt(repo, ['add', '.']);
  await gitAt(repo, ['commit', '-m', 'Base']);
  return { root, repo, manager: new Worktrees(repo, 'local-features', path.join(root, 'managed')) };
}

async function commit(cwd, file = 'client/feature.js', body = 'export const feature = 2;\n') {
  await fs.writeFile(path.join(cwd, file), body);
  await gitAt(cwd, ['add', file]);
  await gitAt(cwd, ['commit', '-m', `Change ${file}`]);
}

function successful(notesVersion = 0, report = 'Completed and tested.') {
  return {
    code: 0,
    progress: { sessionId: 'session-kept', initialized: true, turns: 3 },
    result: {
      subtype: 'success',
      usage: { input_tokens: 3, output_tokens: 5 },
      structured_output: { outcome: 'complete', report, notesVersion },
    },
  };
}

function engineFor(f, options = {}) {
  const db = new Map();
  const calls = { sessions: [], tested: [], built: [], applied: [] };
  const engine = new Engine({
    worktrees: f.manager,
    update: async (id, row) => db.set(id, structuredClone(row)),
    context: async () => ({}),
    prepare: async () => {},
    test: async (cwd) => {
      calls.tested.push(await headAt(cwd));
      return { ok: true, text: 'Passed.' };
    },
    deployment: {
      build: async (job, save) => {
        calls.built.push(job.testedSha);
        await save({ imageId: 'sha256:candidate' });
      },
      previousImage: async () => 'sha256:previous',
      apply: async (image) => {
        calls.applied.push(image);
        return { ok: true, text: 'Verified.' };
      },
    },
    session: async (args) => {
      calls.sessions.push(args);
      await args.onSpawn(999999, () => {});
      await commit(args.cwd);
      return successful();
    },
    maxContinuations: 0,
    ...options,
  });
  return { engine, calls, db };
}

test('dirty operator index and untracked work stay byte-for-byte unchanged; integration waits', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, 'README.md'), 'operator staged\n');
  await gitAt(f.repo, ['add', 'README.md']);
  await fs.writeFile(path.join(f.repo, 'README.md'), 'operator unstaged\n');
  await fs.writeFile(path.join(f.repo, 'new-file'), 'untracked\n');
  const index = await gitAt(f.repo, ['diff', '--cached']);
  const diff = await gitAt(f.repo, ['diff']);
  const head = await headAt(f.repo);
  const { engine, calls } = engineFor(f);
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  const job = await f.manager.read(ID);
  assert.equal(job.status, 'awaiting_integration');
  assert.equal(await headAt(f.repo), head);
  assert.equal(await gitAt(f.repo, ['diff', '--cached']), index);
  assert.equal(await gitAt(f.repo, ['diff']), diff);
  assert.equal(await fs.readFile(path.join(f.repo, 'new-file'), 'utf8'), 'untracked\n');
  assert.equal(await fs.readFile(path.join(job.worktree, 'README.md'), 'utf8'), 'base\n');
  assert.equal(calls.applied.length, 0);
});

test('completed source is tested, built, merged and deployed; cleanup leaves a recovery ref', async (t) => {
  const f = await fixture(t);
  const { engine, calls } = engineFor(f);
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  const job = await f.manager.read(ID);
  assert.equal(job.status, 'done');
  assert.deepEqual(calls.built, calls.tested);
  assert.deepEqual(calls.applied, ['sha256:candidate']);
  assert.equal(
    await gitAt(f.repo, ['show', `${job.integratedSha}^2:client/feature.js`]),
    'export const feature = 2;',
  );
  assert.equal(await gitAt(f.repo, ['rev-parse', job.recoveryRef]), job.testedSha);
  assert.ok(job.cleanedAt);
  await assert.rejects(fs.stat(job.worktree), { code: 'ENOENT' });
  await assert.rejects(engine.resume(ID));
});

test('cutoff retains committed AND uncommitted work; resumption uses same session and cwd', async (t) => {
  const f = await fixture(t);
  let count = 0;
  let first;
  const { engine, calls } = engineFor(f, {
    session: async (args) => {
      await args.onSpawn(999999, () => {});
      if (!count++) {
        first = args;
        await commit(args.cwd);
        await fs.writeFile(path.join(args.cwd, 'README.md'), 'unfinished\n');
        return {
          code: 1,
          progress: { sessionId: args.sessionId, initialized: true },
          result: { subtype: 'error_max_turns', is_error: true },
        };
      }
      assert.equal(args.cwd, first.cwd);
      assert.equal(args.sessionId, first.sessionId);
      assert.equal(args.resume, true);
      assert.equal(await fs.readFile(path.join(args.cwd, 'README.md'), 'utf8'), 'unfinished\n');
      await gitAt(args.cwd, ['add', 'README.md']);
      await gitAt(args.cwd, ['commit', '-m', 'Finish notes']);
      return successful();
    },
  });
  const initial = await headAt(f.repo);
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'paused');
  assert.equal(await headAt(f.repo), initial);
  assert.equal(calls.tested.length, 0);
  await engine.resume(ID);
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'done');
});

test('automatic continuation is bounded and never publishes a cutoff', async (t) => {
  const f = await fixture(t);
  let count = 0;
  const { engine, calls } = engineFor(f, {
    maxContinuations: 2,
    session: async (args) => {
      await args.onSpawn(999999, () => {});
      count++;
      return {
        code: 1,
        progress: { sessionId: args.sessionId, initialized: true },
        result: { subtype: 'error_max_turns', is_error: true },
      };
    },
  });
  await engine.start(ID, 'Investigate the feature', 'user');
  await engine.task;
  assert.equal(count, 3);
  assert.equal((await f.manager.read(ID)).status, 'paused');
  assert.equal(calls.tested.length, 0);
});

test('new notes during testing prevent publication and resume into the same investigation', async (t) => {
  const f = await fixture(t);
  let engine;
  ({ engine } = engineFor(f, {
    test: async () => {
      await engine.note(ID, 'Keep the old default.', 'user');
      return { ok: true, text: 'passed' };
    },
  }));
  const initial = await headAt(f.repo);
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  const job = await f.manager.read(ID);
  assert.equal(job.status, 'paused');
  assert.equal(job.stoppedBecause, 'new_notes');
  assert.equal(job.notesVersion, 1);
  assert.equal(await headAt(f.repo), initial);
});

test('notes already received at the publication fence are not mislabelled late', async (t) => {
  const f = await fixture(t);
  const { engine } = engineFor(f);
  await f.manager.create(ID);
  await engine.patch(ID, { notesVersion: 0, acknowledgedNotes: 0 });
  const receipt = engine.note(ID, 'Stop before changing the default.', 'user');
  assert.equal(await engine.publicationFence(ID), false);
  assert.equal((await receipt).late, false);
});

test('notes during deployment are explicit record-only follow-up', async (t) => {
  const f = await fixture(t);
  const { engine } = engineFor(f);
  engine.deployment.apply = async () => {
    const receipt = await engine.note(ID, 'One more thing', 'user');
    assert.equal(receipt.late, true);
    return { ok: true, text: 'Verified' };
  };
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'done');
  assert.equal((await f.manager.read(ID)).notesVersion, 0);
});

test('validation failure retains branch without reverting anything; resume receives failure notes', async (t) => {
  const f = await fixture(t);
  const { engine, calls } = engineFor(f, {
    test: async () => ({ ok: false, text: 'Expected 2, received 1.' }),
  });
  const initial = await headAt(f.repo);
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  const job = await f.manager.read(ID);
  assert.equal(job.status, 'tests_failed');
  assert.equal(await headAt(f.repo), initial);
  assert.equal(calls.applied.length, 0);
  assert.match(await fs.readFile(f.manager.paths(ID).notes, 'utf8'), /Expected 2/);
  assert.notEqual(job.headSha, initial);
});

test('target advancement is merged in isolation and included in validation', async (t) => {
  const f = await fixture(t);
  const { engine, calls } = engineFor(f, {
    session: async (args) => {
      await commit(args.cwd);
      await commit(f.repo, 'README.md', 'human commit\n');
      return successful();
    },
  });
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  const job = await f.manager.read(ID);
  assert.equal(job.status, 'done');
  assert.equal(await gitAt(f.repo, ['show', `${calls.tested[0]}:README.md`]), 'human commit');
  assert.deepEqual(job.files, ['client/feature.js']);
});

test('conflicting target advances are preserved for the coding agent in its own worktree', async (t) => {
  const f = await fixture(t);
  const { engine } = engineFor(f, {
    session: async (args) => {
      await commit(args.cwd);
      await commit(f.repo, 'client/feature.js', 'export const feature = 3;\n');
      return successful();
    },
  });
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  const job = await f.manager.read(ID);
  assert.equal(job.status, 'paused');
  assert.match(await dirtyAt(job.worktree), /UU client/);
  assert.equal(
    await fs.readFile(path.join(f.repo, 'client/feature.js'), 'utf8'),
    'export const feature = 3;\n',
  );
});

test('operator edits arriving after testing prevent integration', async (t) => {
  const f = await fixture(t);
  const { engine } = engineFor(f, {
    test: async () => {
      await fs.writeFile(path.join(f.repo, 'README.md'), 'human working\n');
      return { ok: true, text: 'passed' };
    },
  });
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'awaiting_integration');
  assert.equal(await fs.readFile(path.join(f.repo, 'README.md'), 'utf8'), 'human working\n');
});

test('retrying integration does not rerun Claude; it does retest the current candidate', async (t) => {
  const f = await fixture(t);
  await commit(f.repo, 'README.md', 'operator preparation\n');
  const original = await fs.readFile(path.join(f.repo, 'README.md'), 'utf8');
  await fs.writeFile(path.join(f.repo, 'README.md'), 'WIP\n');
  const { engine, calls } = engineFor(f);
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'awaiting_integration');
  await fs.writeFile(path.join(f.repo, 'README.md'), original);
  await engine.resume(ID);
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'done');
  assert.equal(calls.sessions.length, 1);
  assert.equal(calls.tested.length, 2);
});

test('deployment failure restores previous image and reverts only the job merge', async (t) => {
  const f = await fixture(t);
  const { engine, calls } = engineFor(f);
  engine.deployment.apply = async (image) => {
    calls.applied.push(image);
    return {
      ok: image === 'sha256:previous',
      text: image === 'sha256:previous' ? 'Restored' : 'Failed',
    };
  };
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'rolled_back');
  assert.deepEqual(calls.applied, ['sha256:candidate', 'sha256:previous']);
  assert.equal(
    await fs.readFile(path.join(f.repo, 'client/feature.js'), 'utf8'),
    'export const feature = 1;\n',
  );
});

test('rollback never reverts operator edits made during deployment', async (t) => {
  const f = await fixture(t);
  const { engine, calls } = engineFor(f);
  engine.deployment.apply = async (image) => {
    calls.applied.push(image);
    if (image === 'sha256:candidate')
      await fs.writeFile(path.join(f.repo, 'README.md'), 'new human WIP\n');
    return { ok: image === 'sha256:previous', text: image };
  };
  await engine.start(ID, 'Fix the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'recovery_required');
  assert.equal(await fs.readFile(path.join(f.repo, 'README.md'), 'utf8'), 'new human WIP\n');
  assert.equal(calls.applied.at(-1), 'sha256:previous');
});

test('archiving snapshots unfinished work and retains it after worktree/branch removal', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create(ID);
  await fs.writeFile(path.join(job.worktree, 'new scratch with spaces.txt'), 'recover me\n');
  await fs.writeFile(path.join(job.worktree, 'README.md'), 'unfinished\n');
  const archived = await f.manager.archive(ID);
  assert.equal(archived.status, 'archived');
  assert.ok(archived.cleanedAt);
  assert.equal(
    await gitAt(f.repo, ['show', `${archived.recoveryRef}:new scratch with spaces.txt`]),
    'recover me',
  );
});

test('unknown ignored files prevent cleanup instead of disappearing', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create(ID);
  await fs.writeFile(path.join(job.worktree, 'private.local'), 'keep me');
  const result = await f.manager.cleanup(ID);
  assert.match(result.cleanupWarning, /private.local/);
  assert.equal(await fs.readFile(path.join(job.worktree, 'private.local'), 'utf8'), 'keep me');
});

test('credential files are refused even with whitespace/rename paths', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create(ID);
  await fs.writeFile(path.join(job.worktree, '.env'), 'DUMMY_TEST_VALUE=not-a-secret\n');
  await gitAt(job.worktree, ['add', '-f', '.env']);
  await gitAt(job.worktree, ['commit', '-m', 'Bad force-add']);
  await assert.rejects(f.manager.verifyPublishable(ID), /Credential/);
  await assert.rejects(f.manager.archive(ID), /credential/);
});

test('simultaneous job starts cannot both pass the one-job gate', async (t) => {
  const f = await fixture(t);
  let release;
  const block = new Promise((resolve) => {
    release = resolve;
  });
  const { engine } = engineFor(f, { prepare: async () => block });
  const one = engine.start(ID, 'Fix the feature', 'user');
  await assert.rejects(engine.start(SECOND, 'Other job', 'user'), /active/);
  await one;
  release();
  await engine.task;
});

test('startup reconciliation retains paused work and marks interrupted publication for inspection', async (t) => {
  const f = await fixture(t);
  await f.manager.create(ID);
  await f.manager.save(ID, { status: 'running', childPid: null });
  await f.manager.create(SECOND);
  await f.manager.save(SECOND, { status: 'integrating' });
  const { engine } = engineFor(f);
  assert.equal(await engine.recover(), 2);
  assert.equal((await f.manager.read(ID)).status, 'paused');
  assert.equal((await f.manager.read(SECOND)).status, 'recovery_required');
  assert.equal((await f.manager.inventory()).filter((r) => r.retained).length, 2);
});

test('worktree capacity reports retained IDs without deleting them', async (t) => {
  const f = await fixture(t);
  await f.manager.create(ID);
  const { engine } = engineFor(f, { maxWorktrees: 1 });
  await assert.rejects(engine.start(SECOND, 'Another job', 'user'), new RegExp(ID));
  assert.equal((await f.manager.inventory())[0].retained, true);
});

test('supervisor lock rejects concurrent processes and releases only its own lock', async (t) => {
  const f = await fixture(t);
  const release = await acquireLock(f.manager.root);
  await assert.rejects(acquireLock(f.manager.root), /Another supervisor/);
  await release();
  const next = await acquireLock(f.manager.root);
  await next();
});

test('completion needs a successful structured report acknowledging current notes', () => {
  assert.equal(completion(successful(), 0).complete, true);
  assert.equal(completion(successful(), 1).reason, 'new_notes');
  assert.equal(
    completion({ code: 0, result: { subtype: 'success', result: 'done' } }, 0).complete,
    false,
  );
  const output = successful();
  output.result.structured_output.outcome = 'needs_input';
  assert.equal(completion(output, 0).reason, 'needs_input');
});

test('application planning distinguishes API source from sidecar/runtime changes', () => {
  assert.equal(applicationPlan(['client/a.tsx']).automatic, true);
  assert.equal(applicationPlan(['client/a.tsx', 'docker-compose.override.yml']).automatic, false);
  assert.equal(applicationPlan(['mcp-code-agent/runner.js']).automatic, false);
  assert.equal(applicationPlan(['README.md']).imageChange, false);
});

test('a successful model exit with uncommitted edits is paused, never called no-change', async (t) => {
  const f = await fixture(t);
  const { engine, calls } = engineFor(f, {
    session: async ({ cwd }) => {
      await fs.writeFile(path.join(cwd, 'README.md'), 'unfinished');
      return successful();
    },
  });
  await engine.start(ID, 'Investigate the feature', 'user');
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'paused');
  assert.equal(calls.tested.length, 0);
  assert.equal(
    await fs.readFile(path.join(f.manager.paths(ID).worktree, 'README.md'), 'utf8'),
    'unfinished',
  );
});

test('crash between integration commit and manifest update is recovered by verifying both parents', async (t) => {
  const f = await fixture(t);
  let job = await f.manager.create(ID);
  await commit(job.worktree);
  job = await f.manager.save(ID, {
    testedSha: await headAt(job.worktree),
    status: 'integrating',
    integrationExpected: job.integrationBase,
    sessionComplete: true,
    acknowledgedNotes: 0,
    imageId: 'sha256:candidate',
    previousImage: 'sha256:previous',
    application: { automatic: true },
  });
  await gitAt(f.repo, [
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    `Merge code-agent job ${ID}`,
    job.testedSha,
  ]);
  const { engine, calls } = engineFor(f);
  await engine.recover();
  assert.equal((await f.manager.read(ID)).status, 'recovery_required');
  await engine.resume(ID);
  await engine.task;
  assert.equal((await f.manager.read(ID)).status, 'done');
  assert.equal(calls.sessions.length, 0);
  assert.equal(calls.applied[0], 'sha256:candidate');
});

test('cleanup can finish after a crash following worktree removal', async (t) => {
  const f = await fixture(t);
  const job = await f.manager.create(ID);
  await commit(job.worktree);
  await f.manager.snapshot(ID);
  await f.manager.save(ID, { status: 'done' });
  await gitAt(f.repo, ['worktree', 'unlock', job.worktree]);
  await gitAt(f.repo, ['worktree', 'remove', job.worktree]);
  const { engine } = engineFor(f);
  await engine.recover();
  assert.ok((await f.manager.read(ID)).cleanedAt);
  assert.equal(
    await gitAt(f.repo, ['show', `refs/code-agent/jobs/${ID}:client/feature.js`]),
    'export const feature = 2;',
  );
});

test('subprocess parser preserves the final unterminated NDJSON event and does not count messages as turns', async (t) => {
  const f = await fixture(t);
  const code = `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'working'}]}})); process.stdout.write(JSON.stringify({type:'result',subtype:'success',num_turns:7,structured_output:{outcome:'complete',report:'ok',notesVersion:0}})); });`;
  let registered = false;
  const result = await runSession({
    cwd: f.repo,
    prompt: 'test',
    sessionId: 'fixture',
    maxTurns: 250,
    timeoutMs: 5000,
    command: process.execPath,
    extraArgs: ['-e', code],
    onSpawn: async () => {
      registered = true;
    },
  });
  assert.equal(registered, true);
  assert.equal(result.progress.messages, 1);
  assert.equal(result.progress.turns, 7);
  assert.equal(completion(result, 0).complete, true);
});
