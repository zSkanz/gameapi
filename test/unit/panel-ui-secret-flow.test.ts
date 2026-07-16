import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ui = (rel: string): string => readFileSync(join(__dirname, '..', '..', 'src', 'panel-ui', rel), 'utf8');

/**
 * A minted API key exists exactly once: in React state, for the life of one modal. Nothing else
 * holds it — the server stores only its sha256. Two ordinary-looking lines destroyed it in
 * production, and neither typecheck nor any API test can see either one. Hence these.
 */
describe('the newly-minted secret survives long enough to be copied', () => {
  // GameDetail owns the <Outlet/> that renders KeysTab. Every tab calls reloadGame() after a
  // mutation, so a bare `if (game.loading)` swaps the page for a spinner, unmounts the tab, and
  // takes the key with it — the modal never renders.
  it('GameDetail does not unmount its tabs while refreshing', () => {
    const src = ui(join('pages', 'GameDetail.tsx'));
    expect(src).toMatch(/if \(game\.loading && !game\.data\)/);
    expect(src, 'a bare `if (game.loading) return` destroys the active tab state on every reload').not.toMatch(
      /if \(game\.loading\)\s*return/,
    );
  });

  // Escape's default action closes a <dialog>. A no-op onCancel does not stop it — it only stops
  // React finding out, so the element stays closed and the mount effect never reopens it.
  it('a non-dismissable modal actually refuses Escape', () => {
    const src = ui('ui.tsx');
    expect(src).toMatch(/onCancel=\{\(e\) =>/);
    expect(src).toMatch(/if \(!dismissable\) e\.preventDefault\(\)/);
  });

  it('the secret modal is non-dismissable and gates its exit on an acknowledgement', () => {
    const src = ui('ui.tsx');
    const secret = src.slice(src.indexOf('export function SecretModal'));
    expect(secret).toMatch(/dismissable=\{false\}/);
    expect(secret).toMatch(/disabled=\{!ack\}/);
    expect(secret).toMatch(/<CopyButton value=\{secret\} \/>/);
  });

  // The key lives in KeysTab, not in the dialog: the dialog unmounts the moment it succeeds.
  it('KeysTab holds the full key above the dialog that produced it', () => {
    const src = ui(join('pages', 'KeysTab.tsx'));
    expect(src).toMatch(/const \[fullKey, setFullKey\] = useState<string \| null>\(null\)/);
    expect(src).toMatch(/\{fullKey \? \(\s*<SecretModal/);
  });
});
