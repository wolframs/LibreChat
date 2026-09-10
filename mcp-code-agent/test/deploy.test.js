import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../git.js';
import { gitAt, headAt } from '../worktrees.js';

const script = fileURLToPath(new URL('../../scripts/deploy.sh', import.meta.url));
const IMAGE = `sha256:${'a'.repeat(64)}`;

async function setup(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-deploy-test-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  for (const directory of ['scripts', 'searxng', 'nginx', 'fake-bin'])
    await fs.mkdir(path.join(repo, directory));
  await fs.copyFile(script, path.join(repo, 'scripts/deploy.sh'));
  for (const file of ['.env', 'librechat.yaml', 'nginx/default.conf', 'searxng/settings.yml'])
    await fs.writeFile(path.join(repo, file), 'test fixture\n');
  await fs.writeFile(path.join(repo, '.gitignore'), 'fake-bin/\ncommands.log\n');
  await gitAt(repo, ['init', '-b', 'local-features']);
  await gitAt(repo, ['add', '.']);
  await gitAt(repo, ['commit', '-m', 'Deploy fixture']);
  const docker = `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='compose'&&a.includes('ps'))console.log('api');
if(a[0]==='compose'&&a.includes('exec')&&a.includes('node'))console.log('{}');
`;
  const curl = `#!${process.execPath}
if(!process.argv.includes('-o'))console.log('{"rates":1,"endpoints":["test"]}');
`;
  await fs.writeFile(path.join(repo, 'fake-bin/docker'), docker, { mode: 0o755 });
  await fs.writeFile(path.join(repo, 'fake-bin/curl'), curl, { mode: 0o755 });
  const env = {
    PATH: `${path.join(repo, 'fake-bin')}:${process.env.PATH}`,
    COMMAND_LOG: path.join(repo, 'commands.log'),
    DEPLOY_EXPECTED_HEAD: await headAt(repo),
  };
  return { repo, env };
}

test('prebuilt deployment tags the immutable image and recreates only api without building source', async (t) => {
  const { repo, env } = await setup(t);
  const result = await run('bash', ['./scripts/deploy.sh', '--yes', '--image', IMAGE], {
    cwd: repo,
    env,
  });
  assert.equal(result.err, null, result.stdout + result.stderr);
  const calls = (await fs.readFile(env.COMMAND_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((a) => a.join(' ') === `image tag ${IMAGE} librechat-fork:local`));
  assert.deepEqual(
    calls.filter((a) => a.includes('up')),
    [['compose', 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'api']],
  );
  assert.equal(
    calls.some((a) => a.includes('build')),
    false,
  );
});

test('prebuilt deployment refuses new WIP and does not even retag the image', async (t) => {
  const { repo, env } = await setup(t);
  await fs.writeFile(path.join(repo, 'operator-wip'), 'keep this');
  const result = await run('bash', ['./scripts/deploy.sh', '--yes', '--image', IMAGE], {
    cwd: repo,
    env,
  });
  assert.ok(result.err);
  assert.match(result.stderr, /Operator checkout changed/);
  assert.doesNotMatch(await fs.readFile(env.COMMAND_LOG, 'utf8'), /tag|force-recreate/);
});

test('rollback can restore an image despite later WIP without building or reverting that WIP', async (t) => {
  const { repo, env } = await setup(t);
  await fs.writeFile(path.join(repo, 'operator-wip'), 'keep this');
  const result = await run('bash', ['./scripts/deploy.sh', '--yes', '--image', IMAGE], {
    cwd: repo,
    env: { ...env, CODE_AGENT_ROLLBACK: '1' },
  });
  assert.equal(result.err, null, result.stdout + result.stderr);
  assert.equal(await fs.readFile(path.join(repo, 'operator-wip'), 'utf8'), 'keep this');
});
