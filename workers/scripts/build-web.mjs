import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'workers/dist');
await mkdir(join(output, 'assets'), { recursive: true });
await mkdir(join(output, 'images'), { recursive: true });
const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
await build({ define: { __BYOB_VERSION__: JSON.stringify(version) }, entryPoints: [join(root, 'workers/web/app.mjs')], outfile: join(output, 'assets/app.js'), bundle: true, format: 'esm', target: 'es2022', minify: true });
const require = createRequire(import.meta.url);
const tailwind = join(dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs');
execFileSync(process.execPath, [tailwind, '--input=workers/web/app.css', `--output=${join(output, 'assets/app.css')}`, '--minify'], { cwd: root, stdio: 'inherit' });
await Promise.all([
  copyFile(join(root, 'workers/web/index.html'), join(output, 'index.html')),
  ...['logo.svg', 'favicon.svg'].map(name => copyFile(join(root, 'assets/static/images', name), join(output, 'images', name))),
  ...['favicon.ico', 'robots.txt'].map(name => copyFile(join(root, 'assets/static', name), join(output, name))),
]);
console.log('Built native browser assets in workers/dist');
