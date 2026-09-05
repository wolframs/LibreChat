import { execFile } from 'child_process';

export const REPO = process.env.REPO_PATH || '/Users/wolfram/projects/librechat';
export const BRANCH = process.env.DEPLOY_BRANCH || 'local-features';

export function run(cmd, args, { cwd = REPO, timeout = 60_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

export const git = (args, opts) => run('git', args, opts);

export async function head() {
  const { stdout } = await git(['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function currentBranch() {
  const { stdout } = await git(['branch', '--show-current']);
  return stdout.trim();
}

/** Empty string means clean. Returned verbatim to the caller when it isn't. */
export async function porcelain() {
  const { stdout } = await git(['status', '--porcelain']);
  return stdout.trim();
}

export async function commitsSince(sha) {
  const { stdout } = await git(['log', '--format=%H%x00%s', `${sha}..HEAD`]);
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split('\0');
      return { hash, short: hash.slice(0, 9), subject };
    });
}

export async function diffstat(sha) {
  const { stdout } = await git(['diff', '--stat', `${sha}..HEAD`]);
  return stdout.trim();
}

export async function filesChanged(sha) {
  const { stdout } = await git(['diff', '--name-only', `${sha}..HEAD`]);
  return stdout.split('\n').filter(Boolean);
}

/**
 * The undo, spelled out with the hashes filled in.
 *
 * Reversibility that requires you to work out the command is reversibility you
 * will not reach for at 2am, so this string goes in the changelog, in the tool
 * result, and in the rollback path — the same command in all three places.
 */
export function revertCommand(commits) {
  if (!commits.length) return null;
  const hashes = commits.map((c) => c.short).join(' ');
  return `git revert --no-edit ${hashes} && ./scripts/deploy.sh --yes`;
}

/** Newest first, which is the order revert needs to apply them without conflict. */
export async function revert(commits) {
  return git(['revert', '--no-edit', ...commits.map((c) => c.hash)], { timeout: 120_000 });
}
