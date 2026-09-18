import { useRef, type KeyboardEvent } from 'react';

/**
 * JSON highlighting and the editor the Config tab's json values are typed into.
 *
 * Same trade as luau.tsx: a regex tokenizer instead of CodeMirror/Monaco (hundreds of KB) for one
 * textarea. The editor is the classic overlay — a transparent <textarea> on top of a coloured
 * <pre> with identical metrics — so the browser keeps doing selection, undo and IME for us.
 */

export type JsonTokenClass = 'tok-key' | 'tok-s' | 'tok-n' | 'tok-k' | 'tok-p';
export interface JsonToken {
  text: string;
  cls: JsonTokenClass | null;
}

/**
 * ORDER IS THE DESIGN. A key is a string followed by `:`, so it must match before the plain string
 * branch or every key comes out string-coloured. Strings stop at a newline so an unclosed quote
 * colours one line, not the rest of the document.
 */
const JSON_RE = new RegExp(
  [
    String.raw`("(?:\\.|[^"\\\n])*")(?=\s*:)`, // 1 key
    String.raw`("(?:\\.|[^"\\\n])*"?)`, // 2 string (closing quote optional while typing)
    String.raw`(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`, // 3 number
    String.raw`\b(true|false|null)\b`, // 4 literal
    String.raw`([{}[\],:])`, // 5 punctuation
  ].join('|'),
  'g',
);

const CLASSES: JsonTokenClass[] = ['tok-key', 'tok-s', 'tok-n', 'tok-k', 'tok-p'];

/** Lossless, like tokenizeLuau: the tokens join back into the input exactly. */
export function tokenizeJson(code: string): JsonToken[] {
  const out: JsonToken[] = [];
  let last = 0;
  for (const m of code.matchAll(JSON_RE)) {
    const at = m.index;
    if (at > last) out.push({ text: code.slice(last, at), cls: null });
    const group = m.findIndex((g, i) => i > 0 && g !== undefined) - 1;
    out.push({ text: m[0], cls: CLASSES[group] ?? null });
    last = at + m[0].length;
  }
  if (last < code.length) out.push({ text: code.slice(last), cls: null });
  return out;
}

export function JsonEditor({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}): JSX.Element {
  const pre = useRef<HTMLPreElement>(null);

  // execCommand is deprecated but still the only way to insert text that lands on the textarea's
  // own undo stack — setting value directly makes Ctrl+Z forget the edit.
  function insert(ta: HTMLTextAreaElement, text: string) {
    ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      onChange(ta.value);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      insert(ta, '  ');
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Keep the current line's indent, one level deeper after an opening bracket.
      e.preventDefault();
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const indent = /^\s*/.exec(line)![0];
      insert(ta, '\n' + indent + (/[{[]\s*$/.test(line) ? '  ' : ''));
    }
  }

  return (
    <div className={`json-editor${disabled ? ' disabled' : ''}`}>
      <pre ref={pre} className="json-editor-hl" aria-hidden="true">
        {tokenizeJson(value).map((tok, i) =>
          tok.cls === null ? (
            tok.text
          ) : (
            <span key={i} className={tok.cls}>
              {tok.text}
            </span>
          ),
        )}
        {/* Room for the textarea's horizontal scrollbar, or the last line drifts at max scroll. */}
        {'\n\n'}
      </pre>
      <textarea
        id={id}
        className="json-editor-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          pre.current!.scrollTop = e.currentTarget.scrollTop;
          pre.current!.scrollLeft = e.currentTarget.scrollLeft;
        }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        wrap="off"
        rows={14}
      />
    </div>
  );
}
