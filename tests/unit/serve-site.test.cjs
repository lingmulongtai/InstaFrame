const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

let root;
let server;
let origin;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'instaframe-server-'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>test</title>');
  await writeFile(path.join(root, 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  const { createStaticServer } = await import('../../scripts/serve-site.mjs');
  server = createStaticServer({ rootDirectory: root, hostname: '127.0.0.1', listenPort: 0 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('local server uses strict browser MIME handling for self-hosted fonts', async () => {
  const response = await fetch(`${origin}/font.woff2`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'font/woff2');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x77, 0x4f, 0x46, 0x32]);
});
