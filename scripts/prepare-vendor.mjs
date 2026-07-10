import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'vendor');
const files = [
  ['node_modules/exifr/dist/full.umd.js', 'exifr.js'],
  ['node_modules/exifr/LICENSE', 'LICENSE-exifr.txt'],
  ['node_modules/jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['node_modules/jszip/LICENSE.markdown', 'LICENSE-jszip.md'],
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const [source, target] of files) {
  await cp(path.join(root, source), path.join(output, target));
}

console.log(`Prepared pinned browser dependencies at ${output}`);
