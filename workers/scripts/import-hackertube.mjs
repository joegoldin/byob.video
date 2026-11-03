import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hackerTubeExport, projectHackerTube } from './hackertube-data.mjs';

try {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node workers/scripts/import-hackertube.mjs /path/to/videos.jsonl');
  const info = await stat(path);
  if (!info.isFile() || info.size > 12 * 1024 * 1024) throw new Error('invalid_hackertube_size');
  const snapshot = projectHackerTube(await readFile(path, 'utf8'));
  if (snapshot.source_sha256 !== hackerTubeExport.sha256 || snapshot.source_rows !== hackerTubeExport.rows) throw new Error('Unreviewed HackerTube export: review the new data before changing its pinned hash');
  const output = new URL('../src/data/hackertube.json', import.meta.url);
  await mkdir(dirname(fileURLToPath(output)), { recursive: true });
  await writeFile(output, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${snapshot.ids.length} reviewed HackerTube IDs; omitted all free-form metadata`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
