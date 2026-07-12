import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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

const fonts = [
  ['inter', 'Inter'],
  ['montserrat', 'Montserrat'],
  ['dm-sans', 'DM Sans'],
  ['lato', 'Lato'],
  ['poppins', 'Poppins'],
  ['raleway', 'Raleway'],
  ['nunito', 'Nunito'],
  ['josefin-sans', 'Josefin Sans'],
  ['oswald', 'Oswald'],
  ['work-sans', 'Work Sans'],
  ['playfair-display', 'Playfair Display'],
  ['cormorant-garamond', 'Cormorant Garamond'],
  ['eb-garamond', 'EB Garamond'],
  ['libre-baskerville', 'Libre Baskerville'],
  ['cinzel', 'Cinzel'],
  ['source-serif-4', 'Source Serif 4'],
];

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'leaflet'), { recursive: true });
await mkdir(path.join(output, 'fonts'), { recursive: true });

for (const [source, target] of files) {
  await cp(path.join(root, source), path.join(output, target));
}

await cp(path.join(root, 'node_modules/leaflet/dist/images'), path.join(output, 'leaflet/images'), { recursive: true });

const fontCss = [];
for (const [slug, family] of fonts) {
  const packageRoot = path.join(root, 'node_modules', '@fontsource', slug);
  const packageFiles = await readdir(path.join(packageRoot, 'files'));
  const selected = packageFiles.filter(name => (
    new RegExp(`^${slug}-latin-(300|400|500|700)-(normal|italic)\\.woff2$`).test(name)
  ));
  for (const name of selected) {
    const match = name.match(/-latin-(\d+)-(normal|italic)\.woff2$/);
    if (!match) continue;
    const [, weight, style] = match;
    await cp(path.join(packageRoot, 'files', name), path.join(output, 'fonts', name));
    fontCss.push(`@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url('./${name}') format('woff2'); }`);
  }
  await cp(path.join(packageRoot, 'LICENSE'), path.join(output, 'fonts', `LICENSE-${slug}.txt`));
}
await writeFile(path.join(output, 'fonts', 'fonts.css'), `${fontCss.join('\n')}\n`);

console.log(`Prepared pinned browser dependencies at ${output}`);
