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

/** Syntax-highlight a JSON value directly from the object (accurate, no parser). */
function highlightJson(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  const padIn = '  '.repeat(indent + 1);
  if (value === null) return `<span class="tok-null">null</span>`;
  if (typeof value === 'string') return `<span class="tok-str">${esc(JSON.stringify(value))}</span>`;
  if (typeof value === 'number') return `<span class="tok-num">${esc(String(value))}</span>`;
  if (typeof value === 'boolean') return `<span class="tok-bool">${value}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => padIn + highlightJson(v, indent + 1)).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const items = entries
      .map(([k, v]) => `${padIn}<span class="tok-key">${esc(JSON.stringify(k))}</span>: ${highlightJson(v, indent + 1)}`)
      .join(',\n');
    return `{\n${items}\n${pad}}`;
  }
  return esc(String(value));
}

const LUA_KEYWORDS = new Set([
  'local', 'function', 'end', 'if', 'then', 'else', 'elseif', 'for', 'in', 'do',
  'while', 'repeat', 'until', 'return', 'and', 'or', 'not', 'break', 'continue',
]);
const LUA_LITERALS = new Set(['true', 'false', 'nil']);

/** Minimal Luau tokenizer -> highlighted HTML. */
function highlightLua(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  const span = (cls: string, text: string) => (out += `<span class="${cls}">${esc(text)}</span>`);
  while (i < n) {
    const c = code[i]!;
    if (c === '-' && code[i + 1] === '-') {
      let j = i + 2;
      while (j < n && code[j] !== '\n') j++;
      span('tok-com', code.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c) {
        if (code[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      span('tok-str', code.slice(i, j));
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && /[0-9.xXa-fA-F]/.test(code[j]!)) j++;
      span('tok-num', code.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      if (LUA_KEYWORDS.has(word)) span('tok-kw', word);
      else if (LUA_LITERALS.has(word)) span('tok-bool', word);
      else if (code[j] === '(') span('tok-fn', word);
      else out += esc(word);
      i = j;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

/** A collapsible code block (click the title to open/close). Default: collapsed. */
function block(title: string, highlightedHtml: string): string {
  return `<details class="block"><summary>${esc(title)}</summary><pre class="code">${highlightedHtml}</pre></details>`;
}

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

function endpointCard(e: EndpointDoc): string {
  const color = METHOD_COLORS[e.method.toUpperCase()] ?? '#6b7280';
  const chips = [e.auth ? chip('x-api-key', 'auth') : '', e.idempotency ? chip('Idempotency-Key', 'idem') : ''].join('');
  return `
    <div class="ep">
      <div class="ep-head">
        <span class="method" style="background:${color}">${esc(e.method)}</span>
        <code class="path">${esc(e.path)}</code>
        <span class="chips">${chips}</span>
      </div>
      ${e.summary ? `<div class="summary">${esc(e.summary)}</div>` : ''}
      ${e.params ? paramsTable(e.params) : ''}
      ${e.body ? block('Request body (JSON Schema)', highlightJson(e.body)) : ''}
      ${e.requestExample ? block('Request body (example)', highlightJson(e.requestExample)) : ''}
      ${e.roblox ? block('Roblox (Luau) example', highlightLua(e.roblox)) : ''}
      ${e.responseExample ? block('Response example', highlightJson(e.responseExample)) : ''}
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
    .map(([group, eps]) => `<section><h2>${esc(group)}</h2>${eps.map(endpointCard).join('')}</section>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GameApi — API reference</title>
<style>
  :root {
    --bg:#f6f7f9; --fg:#0f1219; --muted:#5a6275; --card:#ffffff; --border:#e6e9ef;
    --code-bg:#f6f7f9; --chip-auth:#4f46e5; --chip-idem:#c2410c; --accent:#4f46e5;
    --shadow:0 1px 2px rgb(16 24 40 / .04), 0 1px 3px rgb(16 24 40 / .06);
    --t-key:#0550ae; --t-str:#0a7d33; --t-num:#8250df; --t-bool:#cf222e;
    --t-kw:#cf222e; --t-com:#6e7781; --t-fn:#6639ba;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0b0d12; --fg:#eceef3; --muted:#9aa2b5; --card:#14171f; --border:rgb(255 255 255 / .075);
      --code-bg:#0f1117; --chip-auth:#6366f1; --chip-idem:#c2410c; --accent:#818cf8;
      --shadow:0 1px 2px rgb(0 0 0 / .35), inset 0 1px 0 rgb(255 255 255 / .035);
      --t-key:#79c0ff; --t-str:#a5d6ff; --t-num:#d2a8ff; --t-bool:#ff7b72;
      --t-kw:#ff7b72; --t-com:#8b949e; --t-fn:#d2a8ff;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.55 'Inter Variable',Inter,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
         -webkit-font-smoothing:antialiased; }
  .wrap { max-width:920px; margin:0 auto; padding:32px 20px 64px; }
  header { display:flex; align-items:center; gap:14px; }
  .mark { width:40px; height:40px; border-radius:12px; flex:none; display:grid; place-items:center; color:#fff;
          background:linear-gradient(140deg,#818cf8,#4f46e5 55%,#8b5cf6);
          box-shadow:inset 0 1px 0 rgb(255 255 255 / .25), 0 4px 12px -2px rgb(99 102 241 / .45); }
  header h1 { margin:0 0 2px; font-size:26px; letter-spacing:-.03em; line-height:1.2; }
  header p { margin:0; color:var(--muted); }
  .note { margin:24px 0; padding:14px 18px; background:var(--card); border:1px solid var(--border);
          border-radius:12px; box-shadow:var(--shadow); color:var(--muted); font-size:14px; }
  .note code { color:var(--fg); }
  h2 { margin:40px 0 12px; font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .ep { background:var(--card); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow);
        padding:16px 20px; margin:10px 0; }
  .ep-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .method { color:#fff; font-weight:700; font-size:11px; min-width:56px; text-align:center; padding:4px 8px; border-radius:6px; letter-spacing:.04em; }
  .path { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:14px; word-break:break-all; }
  .chips { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
  .chip { color:#fff; font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; white-space:nowrap; }
  .summary { margin:10px 0 4px; }
  .sub { margin:12px 0 4px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  table.params { width:100%; border-collapse:collapse; font-size:13.5px; }
  table.params td { border:1px solid var(--border); padding:6px 10px; vertical-align:top; }
  code { background:var(--code-bg); padding:1px 5px; border-radius:5px;
         font-family:ui-monospace,Menlo,Consolas,monospace; }

  /* collapsible blocks */
  details.block { border:1px solid var(--border); border-radius:10px; margin:8px 0; background:var(--code-bg); overflow:hidden; }
  details.block > summary { cursor:pointer; padding:8px 12px; font-size:12px; text-transform:uppercase;
        letter-spacing:.04em; color:var(--muted); user-select:none; list-style:none;
        display:flex; align-items:center; gap:8px; }
  details.block > summary::-webkit-details-marker { display:none; }
  details.block > summary::before { content:"\\25B8"; color:var(--muted); transition:transform .15s; }
  details.block[open] > summary::before { transform:rotate(90deg); }
  details.block > summary:hover { color:var(--fg); }
  .code { margin:0; padding:12px; overflow-x:auto; border-top:1px solid var(--border);
          font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.55;
          color:var(--fg); background:transparent; }

  /* tokens */
  .tok-key{color:var(--t-key);} .tok-str{color:var(--t-str);} .tok-num{color:var(--t-num);}
  .tok-bool,.tok-null{color:var(--t-bool);} .tok-kw{color:var(--t-kw);}
  .tok-com{color:var(--t-com); font-style:italic;} .tok-fn{color:var(--t-fn);}

  footer { margin-top:40px; color:var(--muted); font-size:13px; }
  a { color:var(--accent); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <span class="mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg></span>
      <div>
      <h1>GameApi — API reference</h1>
      <p>Auto-generated from the registered routes. ${endpoints.length} endpoints. Click a block title to expand it.</p>
      </div>
    </header>
    <div class="note">
      Every non-<em>System</em> endpoint requires the <code>x-api-key</code> header. Mutations
      also require an <code>Idempotency-Key</code> (generate one per logical action and reuse it
      on retries). All responses use the envelope <code>{ ok, data | error, meta }</code>.
      Machine-readable spec at <a href="/docs.json">/docs.json</a>.
    </div>
    ${sections}
    <footer>GameApi · self-documenting endpoint · this page updates itself as routes change.</footer>
  </div>
</body>
</html>`;
}
