import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';

export const commandScope = new AsyncLocalStorage();

const LAUNCHER = `const {spawn}=require('node:child_process');
process.stdin.once('data',()=>{
  const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore','inherit','inherit']});
  child.on('error',e=>{console.error(e.message);process.exit(127)});
  child.on('exit',(code)=>process.exit(code??1));
});`;

function signal(pid, name) {
  try {
    process.kill(-pid, name);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

/** Persist the process group before allowing a build/test/git command to execute. */
export function managedRun(cmd, args, { cwd, timeout, env }, scope) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', LAUNCHER, cmd, ...args], {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let error = null;
    let killTimer;
    let registration = Promise.resolve();
    const stop = () => {
      error = Object.assign(new Error(`${cmd} stopped or timed out`), { killed: true });
      if (child.pid) signal(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid) signal(child.pid, 'SIGKILL');
      }, 5000);
    };
    const timer = setTimeout(stop, timeout);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (data) => {
      stdout = (stdout + data).slice(-64 * 1024 * 1024);
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-64 * 1024 * 1024);
    });
    child.on('spawn', () => {
      registration = scope
        .start(child.pid, cmd, stop)
        .then(() => child.stdin.end('go\n'))
        .catch((err) => {
          error = err;
          signal(child.pid, 'SIGKILL');
        });
    });
    child.on('error', (err) => {
      error = err;
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (child.pid) signal(child.pid, 'SIGKILL');
      await registration;
      try {
        await scope.end(child.pid);
      } catch (err) {
        error ||= err;
      }
      resolve({
        err:
          error ||
          (code !== 0 ? Object.assign(new Error(`${cmd} exited ${code}`), { code }) : null),
        stdout,
        stderr,
      });
    });
  });
}
