const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const fixturesDoc = fs.readFileSync(path.join(root, 'tests', 'e2e', 'FIXTURES.md'), 'utf8');
const fixtures = [
  {
    name: 'codec-fixture.mp4',
    sha256: 'bafb62332a0b45612eb8697cdd229e4ba46baf39bd04e6a916c20cc5e8382e08',
  },
  {
    name: 'codec-fixture.mov',
    sha256: '54ae77851ba75bb017bbca24fbb946c79f7b091868b5687583481f304e78cd85',
  },
  {
    name: 'audio-fixture.webm',
    sha256: '30c623393fb53d487477a6c900797270c71e0fd16bee8ac10b89591da9edea05',
  },
  {
    name: 'hevc-10bit.mov',
    sha256: '226772af30769ff1ae924c76f80645cd755d585c280ea31c9f0269522be1cef7',
  },
  {
    name: 'heic-plain.heic',
    sha256: 'ca669c14c3bdd9a724049b340a435c5b706984b907e1ab94138cf15737979c7d',
  },
  {
    name: 'heic-spatial.heic',
    sha256: '6f18ecc570c27ff9213154ffd39f948ddb171a8f9a1e29e61c36d5de71bbfbc0',
  },
];

test('documented browser fixtures match their checked-in SHA-256 hashes', () => {
  for (const fixture of fixtures) {
    const bytes = fs.readFileSync(path.join(root, 'tests', 'e2e', fixture.name));
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, fixture.sha256, `${fixture.name} content changed without updating its evidence`);
    assert.match(fixturesDoc, new RegExp(`\\b${fixture.sha256}\\b`));
  }
});
