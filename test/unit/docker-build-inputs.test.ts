import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { globSync } from 'node:fs';

const ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The build runs inside a container that sees ONLY what the Dockerfile copies. A local build sees
 * the whole repo, so an import reaching outside the copied set passes here and fails exclusively
 * in the deploy — which is how `?raw`-importing clients/roblox/GameApiClient.lua shipped broken.
 *
 * These read the real Dockerfile rather than a list of assumptions about it.
 */
describe('everything the build imports is actually copied into the image', () => {
  const dockerfile = read('Dockerfile');
  /** Only the build stage matters: the runtime stage copies dist/, not sources. */
  const buildStage = dockerfile.slice(0, dockerfile.indexOf('# ---- runtime stage ----'));
  const copied = [...buildStage.matchAll(/^COPY\s+(?!--from)(.+?)\s+\.\/?\S*$/gm)]
    .flatMap((m) => m[1]!.trim().split(/\s+/))
    .map((p) => p.replace(/\*$/, ''));

  it('copies the source tree and the build scripts at all', () => {
    expect(copied).toContain('src');
    expect(copied).toContain('scripts');
    expect(copied).toContain('tsconfig.json');
  });

  /**
   * The actual regression. src/panel-ui inlines the Luau client with Vite's ?raw, which resolves
   * at BUILD time — so the file has to be in the image even though it never reaches runtime.
   */
  it('copies every directory that a source file imports from outside src/', () => {
    const sources = globSync('src/**/*.{ts,tsx}', { cwd: ROOT });
    const escaping = new Set<string>();

    for (const rel of sources) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      // Both static `from '...'` and dynamic `import('...')`.
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.\.[^'"]*)['"]/g)) {
        const spec = m[1]!.split('?')[0]!; // drop ?raw and friends
        const abs = resolve(join(ROOT, rel), '..', spec);
        const relFromRoot = abs.slice(ROOT.length + 1).replace(/\\/g, '/');
        const topDir = relFromRoot.split('/')[0]!;
        // Anything resolving back inside src/ is covered by `COPY src`.
        if (topDir !== 'src' && !relFromRoot.startsWith('node_modules')) escaping.add(topDir);
      }
    }

    for (const dir of escaping) {
      expect(copied, `src imports from "${dir}/", so the Dockerfile build stage must COPY it`).toContain(dir);
    }
  });

  it('the file the panel inlines is where the import says it is', () => {
    // If this moves, the ?raw import breaks at build time with "Could not resolve" and nothing
    // else in the suite would notice.
    expect(existsSync(join(ROOT, 'clients/roblox/GameApiClient.lua'))).toBe(true);
    expect(read('src/panel-ui/clientSource.tsx')).toContain('clients/roblox/GameApiClient.lua?raw');
  });

  it('.dockerignore does not exclude what the build stage copies', () => {
    const ignored = read('.dockerignore')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    for (const dir of ['src', 'scripts', 'clients']) {
      expect(ignored, `.dockerignore drops "${dir}", which the build stage needs`).not.toContain(dir);
    }
  });
});
