import type { EndpointDoc } from './types';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const METHOD_COLORS: Record<string, string> = {
  GET: '#2563eb',
  POST: '#16a34a',
  PUT: '#d97706',
  PATCH: '#7c3aed',
  DELETE: '#dc2626',
};

function chip(label: string, kind: 'auth' | 'idem'): string {
  const bg = kind === 'auth' ? 'var(--chip-auth)' : 'var(--chip-idem)';
  return `<span class="chip" style="background:${bg}">${esc(label)}</span>`;
}

function paramsTable(params: Record<string, string>): string {
  const rows = Object.entries(params)
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`)
    .join('');
  return `<div class="sub">Path params</div><table class="params"><tbody>${rows}</tbody></table>`;
}

function jsonBlock(title: string, value: unknown): string {
  return `<div class="sub">${esc(title)}</div><pre class="code">${esc(JSON.stringify(value, null, 2))}</pre>`;
}

function endpointCard(e: EndpointDoc): string {
  const color = METHOD_COLORS[e.method.toUpperCase()] ?? '#6b7280';
  const chips = [
    e.auth ? chip('x-api-key', 'auth') : '',
    e.idempotency ? chip('Idempotency-Key', 'idem') : '',
  ].join('');
  return `
    <div class="ep">
      <div class="ep-head">
        <span class="method" style="background:${color}">${esc(e.method)}</span>
        <code class="path">${esc(e.path)}</code>
        <span class="chips">${chips}</span>
      </div>
      ${e.summary ? `<div class="summary">${esc(e.summary)}</div>` : ''}
      ${e.params ? paramsTable(e.params) : ''}
      ${e.body ? jsonBlock('Request body (JSON Schema)', e.body) : ''}
      ${e.requestExample ? jsonBlock('Request body (example)', e.requestExample) : ''}
      ${e.responseExample ? jsonBlock('Response example', e.responseExample) : ''}
    </div>`;
}

export function renderDocsHtml(endpoints: EndpointDoc[]): string {
  const groups = new Map<string, EndpointDoc[]>();
  for (const e of endpoints) {
    const arr = groups.get(e.group) ?? [];
    arr.push(e);
    groups.set(e.group, arr);
  }
  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([group, eps]) =>
        `<section><h2>${esc(group)}</h2>${eps.map(endpointCard).join('')}</section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GameApi — API reference</title>
<style>
  :root {
    --bg:#f7f8fa; --fg:#1f2430; --muted:#6b7280; --card:#ffffff; --border:#e5e7eb;
    --code-bg:#f3f4f6; --chip-auth:#3730a3; --chip-idem:#9a3412; --accent:#2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1420; --fg:#e5e7eb; --muted:#9ca3af; --card:#171d2b; --border:#2a3243;
      --code-bg:#0b1120; --chip-auth:#4f46e5; --chip-idem:#c2410c; --accent:#60a5fa;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:920px; margin:0 auto; padding:32px 20px 64px; }
  header h1 { margin:0 0 4px; font-size:26px; }
  header p { margin:0; color:var(--muted); }
  .note { margin:20px 0; padding:12px 16px; background:var(--card); border:1px solid var(--border);
          border-radius:10px; color:var(--muted); font-size:14px; }
  .note code { color:var(--fg); }
  h2 { margin:32px 0 12px; font-size:18px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  .ep { background:var(--card); border:1px solid var(--border); border-radius:10px;
        padding:14px 16px; margin:10px 0; overflow:hidden; }
  .ep-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .method { color:#fff; font-weight:700; font-size:12px; padding:3px 8px; border-radius:6px;
            letter-spacing:.03em; }
  .path { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:14px; word-break:break-all; }
  .chips { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
  .chip { color:#fff; font-size:11px; padding:2px 7px; border-radius:20px; white-space:nowrap; }
  .summary { margin:10px 0 4px; }
  .sub { margin:12px 0 4px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .code { background:var(--code-bg); border:1px solid var(--border); border-radius:8px;
          padding:10px 12px; overflow-x:auto; font-family:ui-monospace,Menlo,Consolas,monospace;
          font-size:12.5px; margin:0; }
  table.params { width:100%; border-collapse:collapse; font-size:13.5px; }
  table.params td { border:1px solid var(--border); padding:6px 10px; vertical-align:top; }
  code { background:var(--code-bg); padding:1px 5px; border-radius:5px;
         font-family:ui-monospace,Menlo,Consolas,monospace; }
  footer { margin-top:40px; color:var(--muted); font-size:13px; }
  a { color:var(--accent); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>GameApi — API reference</h1>
      <p>Auto-generated from the registered routes. ${endpoints.length} endpoints.</p>
    </header>
    <div class="note">
      Every non-<em>System</em> endpoint requires the <code>x-api-key</code> header. Mutations
      also require an <code>Idempotency-Key</code> (generate one per logical action and reuse it
      on retries). All responses use the envelope
      <code>{ ok, data | error, meta }</code>. Machine-readable spec at
      <a href="/docs.json">/docs.json</a>.
    </div>
    ${sections}
    <footer>GameApi · self-documenting endpoint · this page updates itself as routes change.</footer>
  </div>
</body>
</html>`;
}
