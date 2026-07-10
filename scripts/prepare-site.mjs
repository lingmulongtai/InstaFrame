import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'photo-camera-svgrepo-com.svg'];
const directories = ['css', 'js', 'assets', 'vendor'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of files) {
  const source = path.join(root, file);
  if (!existsSync(source)) throw new Error(`Required site file is missing: ${file}`);
  await cp(source, path.join(output, file));
}

for (const directory of directories) {
  const source = path.join(root, directory);
  if (existsSync(source)) await cp(source, path.join(output, directory), { recursive: true });
}

await writeFile(path.join(output, '.nojekyll'), '');
console.log(`Prepared GitHub Pages artifact at ${output}`);
