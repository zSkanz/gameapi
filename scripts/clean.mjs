// Remove the previous build so stale artifacts (e.g. deleted files) never linger in dist/.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
console.log('cleaned dist/');
