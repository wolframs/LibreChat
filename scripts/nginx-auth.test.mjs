import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit Docker integration test; upstreams are disposable HTTP fixtures.
// Authentication logic itself is covered by middleware/browserSession.spec.ts.
test('nginx sidecar routing authenticates browsers and does not forward credentials', async (t) => {
  const fixture = http.createServer((req, res) => {
    if (req.url.startsWith('/api/auth/')) {
      const role = req.headers.cookie?.match(/fixtureRole=(admin|user)/)?.[1];
      res.statusCode = role ? 204 : 401;
      if (role && req.url === '/api/auth/sidecar-admin' && role !== 'admin') {
        res.statusCode = 403;
      }
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        path: req.url,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      }),
    );
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fixture.close(resolve)));
  const port = fixture.address().port;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'librechat-nginx-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = await fs.readFile(new URL('../nginx/default.conf', import.meta.url), 'utf8');
  const config = source.replace(
    /(?:api:3080|cost-dashboard:5000|host\.docker\.internal:3015)/g,
    `host.docker.internal:${port}`,
  );
  await fs.writeFile(path.join(directory, 'default.conf'), config);
  const name = `librechat-auth-test-${process.pid}`;
  const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  docker(
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::80',
    '-v',
    `${directory}/default.conf:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:alpine',
  );
  t.after(() => docker('stop', '-t', '1', name));
  const endpoint = `http://${docker('port', name, '80/tcp')}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const ready = await fetch(`${endpoint}/cost/healthz`);
      if (ready.ok) break;
    } catch {
      // Container startup is asynchronous.
    }
    await delay(100);
  }
  const cases = [
    ['/cost', null, 401],
    ['/export/all.jsonl.zip', null, 401],
    ['/agent', null, 401],
    ['/cost', 'user', 403],
    ['/export', 'user', 403],
    ['/agent', 'user', 403],
    ['/cost/markets', 'user', 200],
    ['/cost/markets/endpoints', 'user', 200],
    ['/cost', 'admin', 200],
    ['/export', 'admin', 200],
    ['/agent', 'admin', 200],
    ['/cost/healthz', null, 200],
    ['/export/healthz', null, 200],
    ['/_librechat_admin_auth', 'admin', 404],
  ];
  for (const [route, role, status] of cases) {
    const headers = role
      ? {
          Cookie: `fixtureRole=${role}; refreshToken=test-secret`,
          Authorization: 'Bearer test-secret',
        }
      : {};
    const response = await fetch(`${endpoint}${route}`, { headers });
    assert.equal(response.status, status, `${role ?? 'anonymous'} ${route}`);
    if (status !== 200 || !role) continue;
    const body = await response.json();
    assert.equal(body.cookie, undefined, `${route}: cookie must not reach sidecar`);
    assert.equal(body.authorization, undefined, `${route}: bearer must not reach sidecar`);
  }
});
