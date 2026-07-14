const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');

function loadCatalog() {
  const source = `${fs.readFileSync(path.join(root, 'js', 'i18n.js'), 'utf8')}\n;globalThis.__catalog = I18N;`;
  const sandbox = {
    localStorage: { getItem: () => null },
    navigator: { language: 'en', languages: ['en'] },
  };
  vm.runInNewContext(source, sandbox, { filename: 'js/i18n.js' });
  return sandbox.__catalog;
}

function placeholders(message) {
  return [...String(message).matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
    .map(match => match[1])
    .sort();
}

test('English and Japanese catalogs keep the same non-empty keys and placeholders', () => {
  const { en, ja } = loadCatalog();
  const englishKeys = Object.keys(en).sort();
  const japaneseKeys = Object.keys(ja).sort();
  assert.deepEqual(japaneseKeys, englishKeys);

  for (const key of englishKeys) {
    assert.equal(typeof en[key], 'string', `English ${key} must be a string`);
    assert.equal(typeof ja[key], 'string', `Japanese ${key} must be a string`);
    assert.notEqual(en[key].trim(), '', `English ${key} must not be empty`);
    assert.notEqual(ja[key].trim(), '', `Japanese ${key} must not be empty`);
    assert.deepEqual(placeholders(ja[key]), placeholders(en[key]), `${key} placeholders must match`);
  }
});

test('every static HTML translation reference exists in both catalogs', () => {
  const catalog = loadCatalog();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const referencedKeys = new Set(
    [...html.matchAll(/\bdata-i18n(?:-html)?="([^"]+)"/g)].map(match => match[1])
  );

  assert.ok(referencedKeys.size > 0);
  for (const key of referencedKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(catalog.en, key), `Missing English key: ${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(catalog.ja, key), `Missing Japanese key: ${key}`);
  }
});
