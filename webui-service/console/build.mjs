import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { platformArtwork } from './src/platform-artwork.js';
await build({ absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), entryPoints: ['src/app.jsx'], outfile: '../static/console/app.js', bundle: true, minify: true, jsx: 'automatic', target: ['es2020'], define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked', logLevel: 'info' });
await mkdir(new URL('../static/console/platforms/', import.meta.url), { recursive: true });
for (const name of new Set(Object.values(platformArtwork))) await copyFile(new URL(`src/assets/platforms/${name}`, import.meta.url), new URL(`../static/console/platforms/${name}`, import.meta.url));
