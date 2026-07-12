const test = require('node:test');
const assert = require('node:assert/strict');

test('content revisions are deterministic and change with asset contents', async () => {
  const { createContentRevision } = await import('../../scripts/site-assets.mjs');
  const first = createContentRevision([
    { path: 'js/app.js', content: Buffer.from('app') },
    { path: 'index.html', content: Buffer.from('index') },
  ]);
  const reordered = createContentRevision([
    { path: 'index.html', content: Buffer.from('index') },
    { path: 'js/app.js', content: Buffer.from('app') },
  ]);
  const changed = createContentRevision([
    { path: 'js/app.js', content: Buffer.from('app changed') },
    { path: 'index.html', content: Buffer.from('index') },
  ]);

  assert.match(first, /^[a-f0-9]{12}$/);
  assert.equal(reordered, first);
  assert.notEqual(changed, first);
});

test('HTML rewriting gives every local entry asset one shared release revision', async () => {
  const { rewriteHtmlAssetReferences } = await import('../../scripts/site-assets.mjs');
  const html = rewriteHtmlAssetReferences(`
    <link href="css/style.css">
    <script src="js/app.js"></script>
    <script src="vendor/existing.js?mode=min"></script>
    <a href="https://github.com/example/repo">Repository</a>
    <a href="#settings">Settings</a>
  `, 'abcdef123456');

  assert.match(html, /css\/style\.css\?v=abcdef123456/);
  assert.match(html, /js\/app\.js\?v=abcdef123456/);
  assert.match(html, /vendor\/existing\.js\?mode=min&v=abcdef123456/);
  assert.match(html, /href="https:\/\/github\.com\/example\/repo"/);
  assert.match(html, /href="#settings"/);
});
