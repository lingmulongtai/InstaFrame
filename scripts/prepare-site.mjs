import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createContentRevision,
  normalizeReleaseRevision,
  rewriteHtmlAssetReferences,
} from './site-assets.mjs';

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

async function collectFiles(directory, relativeDirectory = '') {
  const entries = [];
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, child.name);
    const absolutePath = path.join(directory, child.name);
    if (child.isDirectory()) entries.push(...await collectFiles(absolutePath, relativePath));
    else entries.push({ path: relativePath, content: await readFile(absolutePath) });
  }
  return entries;
}

const copiedFiles = await collectFiles(output);
const revision = normalizeReleaseRevision(process.env.GITHUB_SHA) || createContentRevision(copiedFiles);
const indexPath = path.join(output, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');
await writeFile(indexPath, rewriteHtmlAssetReferences(indexHtml, revision));
await writeFile(path.join(output, '.nojekyll'), '');
console.log(`Prepared GitHub Pages artifact at ${output} (asset revision ${revision})`);
