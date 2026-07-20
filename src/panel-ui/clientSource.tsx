import { useEffect, useState } from 'react';

/**
 * The Luau client's source, shipped inside the panel.
 *
 * The file lives at clients/roblox/GameApiClient.lua and is NOT in the production image — the
 * Dockerfile copies only src/ — so "get it from the repo" is an instruction nobody looking at this
 * page can follow, least of all an admin without repo access. Vite inlines it with ?raw at build
 * time instead, which also means the panel can only ever show the client version that shipped with
 * it: the two cannot drift.
 *
 * Loaded dynamically so the ~8 KB is a separate chunk that downloads only when someone actually
 * asks to see the client, rather than on every panel page load.
 */
export function useClientSource(): { source: string | null; failed: boolean } {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    import('../../clients/roblox/GameApiClient.lua?raw')
      .then((m) => {
        if (live) setSource(m.default);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return { source, failed };
}

/** Save it as a real file, so it can be dragged into Studio rather than pasted. */
export function downloadClient(source: string): void {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'GameApiClient.lua';
  a.click();
  URL.revokeObjectURL(url);
}
