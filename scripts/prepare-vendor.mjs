import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'vendor');
const files = [
  ['node_modules/exifr/dist/full.umd.js', 'exifr.js'],
  ['node_modules/exifr/LICENSE', 'LICENSE-exifr.txt'],
  ['node_modules/jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['node_modules/jszip/LICENSE.markdown', 'LICENSE-jszip.md'],
  ['node_modules/leaflet/dist/leaflet.js', 'leaflet/leaflet.js'],
  ['node_modules/leaflet/dist/leaflet.css', 'leaflet/leaflet.css'],
  ['node_modules/leaflet/LICENSE', 'leaflet/LICENSE.txt'],
];

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'leaflet'), { recursive: true });

for (const [source, target] of files) {
  await cp(path.join(root, source), path.join(output, target));
}

await cp(path.join(root, 'node_modules/leaflet/dist/images'), path.join(output, 'leaflet/images'), { recursive: true });

console.log(`Prepared pinned browser dependencies at ${output}`);
