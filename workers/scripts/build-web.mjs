import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tailwindBinary } from './toolchain.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'workers/dist');
await mkdir(join(output, 'assets'), { recursive: true });
await mkdir(join(output, 'images'), { recursive: true });
const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
await build({ define: { __BYOB_VERSION__: JSON.stringify(version) }, entryPoints: [join(root, 'workers/web/app.mjs')], outfile: join(output, 'assets/app.js'), bundle: true, format: 'esm', target: 'es2022', minify: true });
const tailwind = await tailwindBinary(root);
execFileSync(tailwind, ['--input=assets/css/app.css', `--output=${join(output, 'assets/app.css')}`, '--minify'], { cwd: root, stdio: 'inherit' });
await Promise.all([
  copyFile(join(root, 'workers/web/index.html'), join(output, 'index.html')),
  ...['logo.svg', 'favicon.svg'].map(name => copyFile(join(root, 'priv/static/images', name), join(output, 'images', name))),
  ...['favicon.ico', 'robots.txt'].map(name => copyFile(join(root, 'priv/static', name), join(output, name))),
]);
console.log('Built native browser assets in workers/dist');
