// Copies non-TS runtime assets (.lua scripts, .sql migrations) from src/ into dist/,
// preserving their relative path, so the compiled build can read them at runtime.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const DIST = path.join(root, 'dist');
const EXTENSIONS = new Set(['.lua', '.sql']);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      const rel = path.relative(SRC, abs);
      const target = path.join(DIST, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(abs, target);
      console.log('copied', rel);
    }
  }
}

await walk(SRC);
console.log('assets copied to dist/');
