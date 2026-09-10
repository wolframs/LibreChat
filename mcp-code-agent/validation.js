import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checked } from './worktrees.js';
import { run } from './git.js';

const WORKSPACES = [
  'packages/data-provider',
  'packages/data-schemas',
  'packages/api',
  'packages/client',
  'api',
  'client',
];

/** A private install keeps workspace symlinks and build outputs inside this job. */
export async function prepareDependencies(cwd, record, save) {
  const lock = await fs.readFile(path.join(cwd, 'package-lock.json'));
  const hash = createHash('sha256').update(lock).digest('hex');
  if (record.dependenciesHash === hash) return;
  await checked('npm', ['ci', '--no-audit', '--no-fund'], { cwd, timeout: 900_000 });
  await checked('npm', ['run', 'build:packages'], { cwd, timeout: 900_000 });
  await save({ dependenciesHash: hash });
}

async function execute(cwd, command, args, timeout = 900_000) {
  const { err, stdout, stderr } = await run(command, args, { cwd, timeout });
  return { ok: !err, out: `${stdout}\n${stderr}`.trim() };
}

export async function runTests(cwd, files) {
  const lines = [];
  const flaky = [];
  if (files.some((f) => f.startsWith('packages/') || /(^|\/)package(-lock)?\.json$/.test(f))) {
    const build = await execute(cwd, 'npm', ['run', 'build:packages']);
    if (!build.ok) return { ok: false, text: `Package build failed:\n${build.out.slice(-5000)}` };
    lines.push('Built workspace packages before testing consumers.');
  }
  let touched = WORKSPACES.filter((ws) => files.some((f) => f.startsWith(`${ws}/`)));
  if (files.some((f) => f.startsWith('packages/') || /^package(-lock)?\.json$/.test(f))) {
    touched = WORKSPACES.filter((ws) => ws !== 'packages/client');
  }
  for (const ws of touched) {
    const first = await execute(cwd, './scripts/agent-test.sh', [ws]);
    if (first.ok) {
      lines.push(first.out.split('\n').slice(-6).join('\n'));
      continue;
    }
    const failed = [
      ...new Set(
        [...first.out.matchAll(/^FAIL\s+(\S+\.(?:spec|test)\.[cm]?[jt]sx?)\s*$/gm)].map(
          (m) => m[1],
        ),
      ),
    ];
    if (!failed.length || failed.length > 8)
      return { ok: false, text: `${ws} failed:\n${first.out.slice(-5000)}` };
    for (const suite of failed) {
      const solo = await execute(cwd, './scripts/agent-test.sh', [ws, suite]);
      if (!solo.ok)
        return {
          ok: false,
          text: `${ws}/${suite} also failed in isolation. This does not establish causality:\n${solo.out.slice(-5000)}`,
        };
      flaky.push(`${ws}/${suite}`);
    }
    lines.push(`${ws}: failing suites passed on isolated rerun (${failed.join(', ')}).`);
  }
  for (const sidecar of ['mcp-code-agent', 'mcp-image-gen']) {
    if (!files.some((f) => f.startsWith(`${sidecar}/`))) continue;
    const dir = path.join(cwd, sidecar);
    const install = await execute(dir, 'npm', ['ci', '--no-audit', '--no-fund']);
    if (!install.ok)
      return { ok: false, text: `${sidecar} install failed:\n${install.out.slice(-3000)}` };
    const tests = await execute(dir, 'npm', ['test']);
    if (!tests.ok)
      return { ok: false, text: `${sidecar} tests failed:\n${tests.out.slice(-5000)}` };
    lines.push(`${sidecar}: ${tests.out.slice(-2000)}`);
  }
  return {
    ok: true,
    text:
      lines.join('\n') ||
      'No supported automated suite matched these files; application may require manual validation.',
    flaky,
  };
}
