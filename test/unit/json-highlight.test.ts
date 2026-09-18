import { describe, it, expect } from 'vitest';
import { tokenizeJson } from '../../src/panel-ui/json';

const classOf = (code: string, text: string): string | null =>
  tokenizeJson(code).find((t) => t.text === text)?.cls ?? null;

describe('json highlighting', () => {
  const doc = '{"goals": [{"id": "likes_1000", "likes": -1.5e3, "on": true, "x": null}]}';

  it('classifies each kind', () => {
    expect(classOf(doc, '"goals"')).toBe('tok-key');
    expect(classOf(doc, '"likes_1000"')).toBe('tok-s');
    expect(classOf(doc, '-1.5e3')).toBe('tok-n');
    expect(classOf(doc, 'true')).toBe('tok-k');
    expect(classOf(doc, 'null')).toBe('tok-k');
    expect(classOf(doc, '{')).toBe('tok-p');
  });

  // The whole reason the key branch comes first.
  it('tells a key from a value string', () => {
    expect(classOf('{"a": "b"}', '"a"')).toBe('tok-key');
    expect(classOf('{"a": "b"}', '"b"')).toBe('tok-s');
    expect(classOf('{"a"  :1}', '"a"')).toBe('tok-key');
  });

  it('does not colour numbers or literals inside a string', () => {
    const toks = tokenizeJson('["true 42 null"]');
    expect(toks.filter((t) => t.cls === 'tok-s').map((t) => t.text)).toEqual(['"true 42 null"']);
    expect(toks.some((t) => t.cls === 'tok-n' || t.cls === 'tok-k')).toBe(false);
  });

  it('keeps an escaped quote inside its string', () => {
    expect(classOf('["say \\"hi\\""]', '"say \\"hi\\""')).toBe('tok-s');
  });

  // Mid-typing: an unclosed quote must colour its own line, not swallow the rest of the document.
  it('stops an unclosed string at the end of the line', () => {
    const toks = tokenizeJson('{"a": "unfinished\n  "b": 2}');
    expect(classOf('{"a": "unfinished\n  "b": 2}', '"b"')).toBe('tok-key');
    expect(toks.find((t) => t.text.startsWith('"unfinished'))!.text).toBe('"unfinished');
  });

  // The editor overlays these tokens on the textarea: a dropped character shifts every glyph after it.
  it('is lossless', () => {
    for (const code of [doc, '{\n  "a": [1, 2,\n  ]\n', '{"a": "x', '  garbage ~ ']) {
      expect(tokenizeJson(code).map((t) => t.text).join('')).toBe(code);
    }
  });
});
