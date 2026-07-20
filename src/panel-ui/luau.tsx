/**
 * A tiny Luau tokenizer, for the one code sample the panel shows.
 *
 * Hand-rolled on purpose: prism-react-renderer (~30 KB) or highlight.js (~100 KB+) in the
 * bundle to colour a single static snippet is not a trade worth making. This is the whole
 * feature in one regex.
 *
 * Its own module rather than living inside RobloxTab so the test can exercise the REAL thing —
 * a copy of the regex in a test file is a test of the copy.
 */

export type TokenClass = 'tok-c' | 'tok-s' | 'tok-n' | 'tok-k' | 'tok-b';
export interface Token {
  text: string;
  cls: TokenClass | null;
}

/**
 * The rendered block. Lives here rather than in a page because two tabs show Luau now — the
 * Roblox one and the funnel setup guide.
 *
 * Rendered as React children, never innerHTML: it cannot inject markup whatever it is handed,
 * and needs no escaping of its own.
 */
export function Luau({ code }: { code: string }): JSX.Element {
  return (
    <pre className="code-block">
      <code>
        {tokenizeLuau(code).map((tok, i) =>
          tok.cls === null ? (
            tok.text
          ) : (
            <span key={i} className={tok.cls}>
              {tok.text}
            </span>
          ),
        )}
      </code>
    </pre>
  );
}

/**
 * ORDER IS THE DESIGN. Comments and strings match first, so `-- local x` stays one comment and
 * `"end"` stays one string. Move the keyword branch up and both start colouring their insides.
 */
const LUAU = new RegExp(
  [
    String.raw`(--\[\[[\s\S]*?\]\]|--[^\n]*)`, // 1 comment: block, then line
    String.raw`("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`, // 2 string, \\. so an escaped quote does not end it
    String.raw`\b(\d+(?:\.\d+)?)\b`, // 3 number
    String.raw`\b(local|function|end|if|then|else|elseif|return|for|in|while|do|repeat|until|break|not|and|or|nil|true|false)\b`, // 4 keyword
    String.raw`\b(game|script|workspace|task|print|warn|pcall|require|self)\b`, // 5 roblox/luau builtin
  ].join('|'),
  'g',
);

const CLASSES: TokenClass[] = ['tok-c', 'tok-s', 'tok-n', 'tok-k', 'tok-b'];

/**
 * Split source into tokens. Lossless: joining every `text` back together returns the input
 * exactly, so nothing can be silently dropped from what the operator copies.
 */
export function tokenizeLuau(code: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of code.matchAll(LUAU)) {
    const at = m.index;
    if (at > last) out.push({ text: code.slice(last, at), cls: null });
    // Which alternation matched says what it is. Groups are 1-based, hence the -1.
    const group = m.findIndex((g, i) => i > 0 && g !== undefined) - 1;
    out.push({ text: m[0], cls: CLASSES[group] ?? null });
    last = at + m[0].length;
  }
  if (last < code.length) out.push({ text: code.slice(last), cls: null });
  return out;
}
