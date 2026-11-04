import { build } from 'esbuild';
import { readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const clientRoot = resolve(root, 'dist/client');
const outputRoot = resolve(root, 'dist/server');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.glb': 'model/gltf-binary',
};

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    // Vite output must contain only the application, never hidden config files.
    if (entry.name.startsWith('.')) continue;
    const target = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build output may not contain symbolic links.');
    if (entry.isDirectory()) files.push(...await collect(target));
    else if (entry.isFile() && !target.endsWith('.map')) files.push(target);
  }
  return files;
}

try { await stat(resolve(clientRoot, 'index.html')); }
catch { throw new Error('Build the Vite client first. Expected dist/client/index.html.'); }
const assets = {};
let bytes = 0;
for (const path of await collect(clientRoot)) {
  const content = await readFile(path);
  bytes += content.length;
  assets['/' + relative(clientRoot, path).split(sep).join('/')] = {
    data: content.toString('base64'),
    type: mimeTypes[extname(path)] || 'application/octet-stream',
    etag: '"' + createHash('sha256').update(content).digest('hex').slice(0, 24) + '"',
  };
}
await mkdir(outputRoot, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['server/worker.mjs'],
  outfile: resolve(outputRoot, 'index.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  plugins: [{
    name: 'kira-embedded-public-assets',
    setup(builder) {
      builder.onResolve({ filter: /^kira:assets$/ }, () => ({ path: 'public-assets', namespace: 'kira' }));
      builder.onLoad({ filter: /.*/, namespace: 'kira' }, () => ({
        contents: `export const STATIC_ASSETS = ${JSON.stringify(assets)};`, loader: 'js',
      }));
    },
  }],
});
console.log(`Worker bundle created with ${Object.keys(assets).length} public assets (${(bytes / 1024).toFixed(0)} KiB before encoding).`);
