import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { run } from './git.js';

export const AGENT_ENV = {
  GIT_AUTHOR_NAME: 'LibreChat code-agent',
  GIT_AUTHOR_EMAIL: 'code-agent@librechat.local',
  GIT_COMMITTER_NAME: 'LibreChat code-agent',
  GIT_COMMITTER_EMAIL: 'code-agent@librechat.local',
};

export async function checked(cmd, args, options) {
  const result = await run(cmd, args, options);
  if (result.err)
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: ${(result.stderr || result.stdout || result.err.message).trim().slice(-3000)}`,
    );
  return result.stdout.trim();
}

export const gitAt = (cwd, args) => checked('git', args, { cwd, env: AGENT_ENV });
export const dirtyAt = (cwd) => gitAt(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
export const headAt = (cwd) => gitAt(cwd, ['rev-parse', 'HEAD']);

const secretPath = (p) =>
  (/(^|\/)\.env($|\.)/.test(p) && !p.endsWith('.example')) ||
  /^(librechat\.yaml|searxng\/settings\.yml)$/.test(p);

/** Files in a job are isolated; Git's refs and object store are still shared. */
export class Worktrees {
  constructor(repo, branch, root) {
    this.repo = path.resolve(repo);
    this.branch = branch;
    this.root =
      root ||
      path.join(
        os.homedir(),
        '.local',
        'state',
        'librechat-code-agent',
        createHash('sha256').update(this.repo).digest('hex').slice(0, 12),
      );
    this.writes = new Map();
  }

  paths(id) {
    if (!/^[a-f0-9]{24}$/.test(id))
      throw new Error('Expected a full 24-character job id. Use list_fixes to find it.');
    const directory = path.join(this.root, 'jobs', id);
    return {
      directory,
      worktree: path.join(directory, 'worktree'),
      manifest: path.join(directory, 'job.json'),
      notes: path.join(directory, 'notes.md'),
    };
  }

  save(id, patch) {
    const previous = this.writes.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.write(id, patch));
    this.writes.set(id, next);
    return next;
  }

  async write(id, patch) {
    const p = this.paths(id);
    await fs.mkdir(p.directory, { recursive: true });
    const old = await this.read(id);
    const record = {
      ...old,
      ...(typeof patch === 'function' ? patch(old) : patch),
      id,
      repo: this.repo,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${p.manifest}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, p.manifest);
    return record;
  }

  async read(id) {
    try {
      return JSON.parse(await fs.readFile(this.paths(id).manifest, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async inventory() {
    let ids;
    try {
      ids = await fs.readdir(path.join(this.root, 'jobs'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return Promise.all(
      ids
        .filter((id) => /^[a-f0-9]{24}$/.test(id))
        .map(async (id) => {
          const record = await this.read(id);
          const exists = await fs.stat(this.paths(id).worktree).then(
            () => true,
            () => false,
          );
          return {
            id,
            status: record?.status ?? 'unregistered',
            retained: exists,
            branch: record?.branch,
            cleanupWarning: record?.cleanupWarning,
            recoveryRef: record?.recoveryRef,
          };
        }),
    );
  }

  async target() {
    return gitAt(this.repo, ['rev-parse', `refs/heads/${this.branch}`]);
  }

  async create(id) {
    const p = this.paths(id);
    if ((await this.read(id))?.baseSha)
      throw new Error('This job already has a worktree record. Resume it instead.');
    const baseSha = await this.target();
    const branch = `code-agent/${id}`;
    await this.save(id, {
      status: 'preparing',
      baseSha,
      integrationBase: baseSha,
      branch,
      worktree: p.worktree,
      createdAt: new Date().toISOString(),
    });
    await gitAt(this.repo, ['worktree', 'add', '-b', branch, p.worktree, baseSha]);
    await gitAt(this.repo, [
      'worktree',
      'lock',
      '--reason',
      `code-agent job ${id}: use archive_fix for cleanup`,
      p.worktree,
    ]);
    return this.read(id);
  }

  async validate(id) {
    const record = await this.read(id);
    const p = this.paths(id);
    if (
      !record ||
      record.repo !== this.repo ||
      record.worktree !== p.worktree ||
      record.branch !== `code-agent/${id}`
    ) {
      throw new Error(
        'Missing or inconsistent worktree ownership record; inspect this job before resuming.',
      );
    }
    const actual = await gitAt(p.worktree, ['rev-parse', '--show-toplevel']);
    if ((await fs.realpath(actual)) !== (await fs.realpath(p.worktree)))
      throw new Error('Worktree path no longer belongs to this job.');
    const common = await gitAt(p.worktree, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const expected = await gitAt(this.repo, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if ((await fs.realpath(common)) !== (await fs.realpath(expected)))
      throw new Error('Worktree belongs to a different repository.');
    if ((await gitAt(p.worktree, ['branch', '--show-current'])) !== record.branch)
      throw new Error('Job worktree is on an unexpected branch.');
    return record;
  }

  async snapshot(id, base) {
    const job = await this.validate(id);
    const sha = await headAt(job.worktree);
    const reference = `refs/code-agent/jobs/${id}`;
    await gitAt(this.repo, ['update-ref', reference, sha]);
    const since = base ?? job.integrationBase;
    const raw = await gitAt(job.worktree, ['log', '--format=%H%x00%s', `${since}..${sha}`]);
    const commits = raw
      ? raw.split('\n').map((line) => {
          const [hash, subject] = line.split('\0');
          return { hash, short: hash.slice(0, 9), subject };
        })
      : [];
    const files = (await gitAt(job.worktree, ['diff', '--name-only', '-z', since, sha]))
      .split('\0')
      .filter(Boolean);
    const diffstat = await gitAt(job.worktree, ['diff', '--stat', since, sha]);
    return this.save(id, { headSha: sha, recoveryRef: reference, commits, files, diffstat });
  }

  async verifyPublishable(id) {
    const job = await this.validate(id);
    if (await dirtyAt(job.worktree))
      throw new Error(
        'The job has uncommitted edits. They are preserved; resume the session to finish or explain them.',
      );
    const files = (
      await gitAt(job.worktree, ['diff', '--name-only', '-z', job.integrationBase, 'HEAD'])
    )
      .split('\0')
      .filter(Boolean);
    const historical = (
      await gitAt(job.worktree, [
        'log',
        '--format=',
        '--name-only',
        '-z',
        `${job.integrationBase}..HEAD`,
      ])
    )
      .split('\0')
      .map((f) => f.replace(/^\n+/, ''))
      .filter(Boolean);
    const forbidden = [...new Set([...files, ...historical].filter(secretPath))];
    if (forbidden.length)
      throw new Error(`Credential-bearing paths cannot be published: ${forbidden.join(', ')}`);
    if (files.includes('scripts/agent-test.sh'))
      throw new Error('The job changed its own test gate. Manual review is required.');
    return files;
  }

  /** Merge advances in isolation. Conflicts stay in that worktree for the resumed agent. */
  async refresh(id) {
    const job = await this.validate(id);
    await this.verifyPublishable(id);
    const target = await this.target();
    if (target === job.integrationBase) return false;
    await gitAt(job.worktree, ['merge', '--no-edit', target]);
    await this.save(id, { integrationBase: target });
    return true;
  }

  async assertTarget(expected) {
    if ((await gitAt(this.repo, ['branch', '--show-current'])) !== this.branch)
      throw new Error(`Integration waits for the operator checkout to be on ${this.branch}.`);
    if (await dirtyAt(this.repo))
      throw new Error(
        'Integration waits for the operator checkout to be clean. Its edits have not been committed, stashed, or deployed.',
      );
    if ((await headAt(this.repo)) !== expected)
      throw new Error(
        'The integration branch advanced. Resume to merge it in the job worktree and test again.',
      );
  }

  async integrate(id, testedSha) {
    const job = await this.validate(id);
    await this.verifyPublishable(id);
    if ((await headAt(job.worktree)) !== testedSha)
      throw new Error('The job changed after testing; resume to test the new revision.');
    await this.assertTarget(job.integrationBase);
    await this.save(id, {
      status: 'integrating',
      testedSha,
      integrationExpected: job.integrationBase,
    });
    await gitAt(this.repo, [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Merge code-agent job ${id}`,
      testedSha,
    ]);
    const integratedSha = await headAt(this.repo);
    const parents = await gitAt(this.repo, ['rev-list', '--parents', '-n', '1', integratedSha]);
    if (parents !== `${integratedSha} ${job.integrationBase} ${testedSha}`) {
      throw new Error(
        'Integration raced another branch update. The resulting parents differ from the tested transaction; inspect the target before application.',
      );
    }
    return this.save(id, { integratedSha, status: 'integrated' });
  }

  async rollback(id) {
    const job = await this.read(id);
    await this.assertTarget(job.integratedSha);
    await gitAt(this.repo, ['revert', '-m', '1', '--no-edit', job.integratedSha]);
    return this.save(id, { rollbackSha: await headAt(this.repo) });
  }

  async archive(id) {
    const job = await this.validate(id);
    const files = (
      await gitAt(job.worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    if (files.some(secretPath))
      throw new Error('A credential-bearing path is present; inspect it before archiving.');
    if (await dirtyAt(job.worktree)) {
      await gitAt(job.worktree, ['add', '-A']);
      await gitAt(job.worktree, ['commit', '-m', `Archive unfinished code-agent job ${id}`]);
    }
    await this.snapshot(id);
    await this.save(id, { status: 'archived', archivedAt: new Date().toISOString() });
    return this.cleanup(id);
  }

  async cleanup(id) {
    const record = await this.read(id);
    if (!record) throw new Error('Missing ownership record.');
    await this.cleanupBuild(id);
    const exists = await fs.stat(this.paths(id).worktree).then(
      () => true,
      () => false,
    );
    if (!exists) {
      const registrations = await gitAt(this.repo, ['worktree', 'list', '--porcelain']);
      if (registrations.includes(`worktree ${this.paths(id).worktree}\n`))
        throw new Error(
          'Worktree directory is missing but remains registered. Inspect before pruning.',
        );
      if (
        !record.recoveryRef ||
        (await gitAt(this.repo, ['rev-parse', record.recoveryRef])) !== record.headSha
      )
        throw new Error('Missing worktree has no verified recovery ref.');
      const branchHead = await gitAt(this.repo, [
        'rev-parse',
        '--verify',
        `refs/heads/${record.branch}`,
      ]).catch(() => null);
      if (branchHead && branchHead !== record.headSha)
        throw new Error('Retained branch advanced after cleanup; leaving it intact.');
      if (branchHead)
        await gitAt(this.repo, ['update-ref', '-d', `refs/heads/${record.branch}`, branchHead]);
      return this.save(id, {
        cleanedAt: record.cleanedAt || new Date().toISOString(),
        cleanupWarning: null,
      });
    }
    const job = await this.validate(id);
    if (await dirtyAt(job.worktree))
      return this.save(id, {
        cleanupWarning: 'Uncommitted work retained; use archive_fix to preserve it before cleanup.',
      });
    await this.snapshot(id);
    const ignored = (
      await gitAt(job.worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    // These directories are reproducible outputs created by dependency setup/tests.
    const generated = /(^|\/)(node_modules|dist|coverage|\.turbo|\.cache)(\/|$)/;
    const unknown = ignored.filter((f) => !generated.test(f));
    if (unknown.length)
      return this.save(id, {
        cleanupWarning: `Ignored files retained for inspection: ${unknown.slice(0, 12).join(', ')}`,
      });
    await gitAt(this.repo, ['worktree', 'unlock', job.worktree]);
    try {
      await gitAt(this.repo, ['worktree', 'remove', '--force', job.worktree]);
    } catch (err) {
      await gitAt(this.repo, [
        'worktree',
        'lock',
        '--reason',
        `code-agent job ${id}`,
        job.worktree,
      ]).catch(() => {});
      return this.save(id, { cleanupWarning: err.message });
    }
    // Archive refs keep commits reachable even when the branch was never integrated.
    await gitAt(this.repo, [
      'update-ref',
      '-d',
      `refs/heads/${job.branch}`,
      (await this.read(id)).headSha,
    ]);
    return this.save(id, { cleanedAt: new Date().toISOString(), cleanupWarning: null });
  }

  async cleanupBuild(id) {
    const job = await this.read(id);
    if (!job?.buildDirectory) return;
    const directory = job.buildDirectory;
    if (
      path.dirname(directory) !== this.paths(id).directory ||
      !/^image-[a-zA-Z0-9]+$/.test(path.basename(directory))
    ) {
      throw new Error('Build snapshot ownership/path mismatch; refusing cleanup.');
    }
    const stat = await fs.lstat(directory).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (stat?.isSymbolicLink())
      throw new Error('Build snapshot path is a symlink; inspect before cleanup.');
    if (stat) await fs.rm(directory, { recursive: true });
    await this.save(id, { buildDirectory: null });
  }
}
