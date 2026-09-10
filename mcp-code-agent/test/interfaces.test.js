import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server.js';
import { describeJob } from '../tools.js';
import { SERVER_INSTRUCTIONS } from '../prompt.js';
import { Deployment } from '../deployment.js';
import { Worktrees, gitAt, headAt } from '../worktrees.js';
import { commandScope } from '../commands.js';
import { run } from '../git.js';

test('real MCP initialization and tool listing expose the complete handoff contract', async () => {
  const server = createMcpServer(new AsyncLocalStorage());
  const client = new Client({ name: 'test-reader', version: '1.0.0' });
  const [one, two] = InMemoryTransport.createLinkedPair();
  await server.connect(one);
  await client.connect(two);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'add_note',
      'archive_fix',
      'check_fix',
      'list_fixes',
      'pause_fix',
      'request_fix',
      'resume_fix',
    ]);
    assert.match(tools.find((tool) => tool.name === 'add_note').description, /record-only/);
    assert.match(
      tools.find((tool) => tool.name === 'resume_fix').description,
      /awaiting_integration/,
    );
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  } finally {
    await client.close();
    await server.close();
  }
});

test('reports never label paused, failed, or pending-application work as deployed', () => {
  for (const status of [
    'paused',
    'tests_failed',
    'applied_pending_restart',
    'awaiting_integration',
  ]) {
    const body = describeJob({
      id: '1234567890abcdef12345678',
      status,
      worktree: '/tmp/job',
      branch: 'code-agent/test',
    });
    assert.doesNotMatch(body, /Done: API image deployed/);
    assert.match(body, new RegExp(status));
  }
  assert.match(
    describeJob({ id: '1234567890abcdef12345678', status: 'done', worktree: '/tmp/job' }),
    /deployed and verified/,
  );
});

test('image build uses only archived tested source, excluding operator WIP and ignored job files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-image-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await gitAt(repo, ['init', '-b', 'local-features']);
  await fs.writeFile(path.join(repo, 'source.txt'), 'committed source');
  await fs.writeFile(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
  await gitAt(repo, ['add', '.']);
  await gitAt(repo, ['commit', '-m', 'Base']);
  const manager = new Worktrees(repo, 'local-features', path.join(root, 'jobs'));
  const id = '1234567890abcdef12345678';
  let job = await manager.create(id);
  await fs.writeFile(path.join(repo, 'source.txt'), 'operator WIP');
  await fs.writeFile(path.join(job.worktree, '.env'), 'TEST_ONLY=ignored');
  await fs.mkdir(path.join(job.worktree, 'node_modules'));
  await fs.writeFile(path.join(job.worktree, 'node_modules/nope'), 'do not bake me');
  job = await manager.save(id, { testedSha: await headAt(job.worktree) });
  let built = false;
  const deployment = new Deployment(repo, manager, async (args, options) => {
    if (args[0] === 'build') {
      built = true;
      assert.equal(
        await fs.readFile(path.join(options.cwd, 'source.txt'), 'utf8'),
        'committed source',
      );
      await assert.rejects(fs.stat(path.join(options.cwd, '.env')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(options.cwd, 'node_modules')), { code: 'ENOENT' });
      assert.ok(args.includes(`BUILD_COMMIT=${job.testedSha}`));
      return '';
    }
    return 'sha256:fixture';
  });
  await deployment.build(job, (patch) => manager.save(id, patch));
  assert.equal(built, true);
  assert.equal((await manager.read(id)).imageId, 'sha256:fixture');
  assert.equal(await fs.readFile(path.join(repo, 'source.txt'), 'utf8'), 'operator WIP');
});

test('pending runtime configuration blocks automatic image application before any deploy command', async () => {
  const deployment = new Deployment('/not-used', null, async (args) => {
    if (args[0] === 'inspect') return 'old-config-hash';
    if (args.includes('config')) return 'api new-config-hash';
    return 'api-container';
  });
  const result = await deployment.apply('sha256:fixture', 'commit');
  assert.equal(result.ok, false);
  assert.equal(result.notAttempted, true);
  assert.match(result.text, /configuration differs/);
});

test('managed subprocess cannot run until its process group has been registered', async () => {
  let registered = false;
  let ended = false;
  const result = await commandScope.run(
    {
      start: async (pid) => {
        assert.ok(pid > 1);
        registered = true;
      },
      end: async () => {
        assert.equal(registered, true);
        ended = true;
      },
    },
    () =>
      run(process.execPath, ['-e', 'console.log("executed")'], { cwd: os.tmpdir(), timeout: 5000 }),
  );
  assert.equal(result.err, null);
  assert.equal(ended, true);
  assert.equal(result.stdout.trim(), 'executed');
});

test('failed process registration prevents the command from executing', async () => {
  const result = await commandScope.run(
    {
      start: async () => {
        throw new Error('persistence failed');
      },
      end: async () => {},
    },
    () =>
      run(process.execPath, ['-e', 'console.log("must not execute")'], {
        cwd: os.tmpdir(),
        timeout: 5000,
      }),
  );
  assert.match(result.err.message, /persistence failed/);
  assert.equal(result.stdout, '');
});

test('managed timeouts kill the command group rather than leaving an active build', async () => {
  let pid;
  const result = await commandScope.run(
    {
      start: async (value) => {
        pid = value;
      },
      end: async () => {},
    },
    () =>
      run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: os.tmpdir(), timeout: 150 }),
  );
  assert.equal(result.err.killed, true);
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
});
