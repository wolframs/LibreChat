import fs from 'node:fs/promises';
import path from 'node:path';
import { checked, gitAt, headAt, dirtyAt } from './worktrees.js';
import { run } from './git.js';

/** Only image-contained source can use automatic application. Bind mounts need a separate decision. */
export function applicationPlan(files) {
  const needsApplication = files.filter(
    (f) =>
      !/^(api\/|client\/|packages\/|e2e\/|scripts\/deploy\.sh$)/.test(f) && !/\.(md|txt)$/.test(f),
  );
  const imageChange = files.some((f) => /^(api\/|client\/|packages\/)/.test(f));
  return { automatic: imageChange && !needsApplication.length, needsApplication, imageChange };
}

export class Deployment {
  constructor(repo, worktrees, docker = (args, options) => checked('docker', args, options)) {
    this.repo = repo;
    this.worktrees = worktrees;
    this.docker = docker;
  }

  compose(args) {
    return this.docker(
      [
        'compose',
        '--project-directory',
        this.repo,
        '-f',
        path.join(this.repo, 'docker-compose.yml'),
        '-f',
        path.join(this.repo, 'docker-compose.override.yml'),
        ...args,
      ],
      { cwd: this.repo },
    );
  }

  async build(job, save) {
    if ((await headAt(job.worktree)) !== job.testedSha || (await dirtyAt(job.worktree)))
      throw new Error('Build revision changed after testing.');
    await this.worktrees.cleanupBuild(job.id);
    const directory = await fs.mkdtemp(path.join(this.worktrees.paths(job.id).directory, 'image-'));
    const archive = path.join(directory, 'source.tar');
    const source = path.join(directory, 'source');
    const image = `librechat-code-agent:${job.id}-${job.testedSha.slice(0, 12)}`;
    await save({ buildDirectory: directory, candidateImage: image });
    await fs.mkdir(source);
    await gitAt(job.worktree, ['archive', '--format=tar', '--output', archive, job.testedSha]);
    await checked('tar', ['-xf', archive, '-C', source], { cwd: directory });
    await this.docker(
      [
        'build',
        '--tag',
        image,
        '--build-arg',
        `BUILD_COMMIT=${job.testedSha}`,
        '--build-arg',
        `BUILD_BRANCH=${job.branch}`,
        source,
      ],
      { cwd: source, timeout: 1_800_000 },
    );
    const imageId = await this.docker(['image', 'inspect', '--format', '{{.Id}}', image], {
      cwd: this.repo,
    });
    await save({ image, imageId });
    // Exact generated directory, recorded before use, containing only git archive output.
    await fs.rm(directory, { recursive: true });
    await save({ buildDirectory: null });
    return imageId;
  }

  async previousImage() {
    const container = await this.compose(['ps', '-q', 'api']);
    if (!container || container.includes('\n'))
      throw new Error('Cannot identify exactly one running API container for rollback.');
    return this.docker(['inspect', '--format', '{{.Image}}', container], { cwd: this.repo });
  }

  async assertRuntimeCurrent() {
    const container = await this.compose(['ps', '-q', 'api']);
    const running = await this.docker(
      [
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.config-hash"}}',
        container,
      ],
      { cwd: this.repo },
    );
    const proposed = await this.compose(['config', '--hash', 'api']);
    if (!running || proposed.split(/\s+/).at(-1) !== running) {
      throw new Error(
        'API runtime configuration differs from the running container. Apply or reconcile that configuration before automatically deploying a job.',
      );
    }
  }

  async apply(image, expectedHead, { rollback = false } = {}) {
    if (!rollback) {
      try {
        await this.assertRuntimeCurrent();
      } catch (err) {
        return { ok: false, notAttempted: true, text: err.message };
      }
    }
    const { err, stdout, stderr } = await run('./scripts/deploy.sh', ['--yes', '--image', image], {
      cwd: this.repo,
      timeout: 1_800_000,
      env: { DEPLOY_EXPECTED_HEAD: expectedHead, CODE_AGENT_ROLLBACK: rollback ? '1' : '0' },
    });
    const text = `${stdout}\n${stderr}`.trim().split('\n').slice(-35).join('\n');
    if (err) return { ok: false, text };
    const actual = await this.previousImage();
    return {
      ok: actual === image,
      text:
        actual === image
          ? text
          : `API image mismatch after application: expected ${image}, got ${actual}.\n${text}`,
    };
  }
}
