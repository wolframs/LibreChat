import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireLock(root) {
  await fs.mkdir(root, { recursive: true });
  const directory = path.join(root, 'supervisor.lock');
  const ownerPath = path.join(directory, 'owner.json');
  const token = randomUUID();
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    } catch {
      throw new Error(`Incomplete supervisor lock at ${directory}; inspect it before removal.`);
    }
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (err) {
      alive = err.code !== 'ESRCH';
    }
    if (alive) throw new Error(`Another supervisor owns ${directory} (PID ${owner.pid}).`);
    await fs.unlink(ownerPath);
    await fs.rmdir(directory);
    return acquireLock(root);
  }
  await fs.writeFile(
    ownerPath,
    JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  return async () => {
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (owner.token !== token) throw new Error('Supervisor lock ownership changed.');
    await fs.unlink(ownerPath);
    await fs.rmdir(directory);
  };
}
