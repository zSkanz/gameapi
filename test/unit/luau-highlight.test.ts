import { describe, it, expect } from 'vitest';
import { tokenizeLuau } from '../../src/panel-ui/luau';

/**
 * A syntax regex fails SILENTLY — it colours the wrong word and nothing complains. And the
 * ordering is the entire design: comments and strings must match before keywords.
 *
 * Imports the real tokenizer. An earlier draft of this file mirrored the regex instead, which
 * is a test of the copy — and the copy was already wrong.
 */
const classOf = (code: string, text: string): string | null =>
  tokenizeLuau(code).find((t) => t.text === text)?.cls ?? null;

describe('luau highlighting', () => {
  it('classifies each kind', () => {
    expect(classOf('local x = 1', 'local')).toBe('tok-k');
    expect(classOf('local t = "hi"', '"hi"')).toBe('tok-s');
    expect(classOf('task.wait(5)', '5')).toBe('tok-n');
    expect(classOf('task.wait(5)', 'task')).toBe('tok-b');
    expect(classOf('-- a note', '-- a note')).toBe('tok-c');
  });

  // The whole reason comments and strings come first in the alternation.
  it('does not colour keywords inside a comment', () => {
    const toks = tokenizeLuau('-- local end function\nlocal x = 1');
    expect(toks[0]).toEqual({ text: '-- local end function', cls: 'tok-c' }); // one token, not four
    expect(classOf('-- local end function\nlocal x = 1', 'local')).toBe('tok-k'); // the real one still works
  });

  it('does not colour keywords inside a string', () => {
    const toks = tokenizeLuau('local s = "end if then"');
    expect(toks.find((t) => t.text === '"end if then"')?.cls).toBe('tok-s');
    expect(toks.some((t) => t.text === 'end' && t.cls === 'tok-k')).toBe(false);
  });

  // The \\. branch. Get it wrong and the string ends early, mis-colouring the rest of the line.
  it('handles an escaped quote without ending the string early', () => {
    const code = 'print("say \\"hi\\" now")';
    expect(tokenizeLuau(code).find((t) => t.cls === 'tok-s')?.text).toBe('"say \\"hi\\" now"');
  });

  it('does not colour a keyword that is part of an identifier', () => {
    // `endPoint` and `localState` are not keywords — \b is what makes that true.
    expect(tokenizeLuau('local endPoint = 1').some((t) => t.text === 'end' && t.cls === 'tok-k')).toBe(false);
    expect(tokenizeLuau('local localState = 1').filter((t) => t.cls === 'tok-k')).toHaveLength(1);
  });

  it('handles a block comment', () => {
    const toks = tokenizeLuau('--[[ local end\n   still a comment ]]\nlocal x = 1');
    expect(toks[0]?.cls).toBe('tok-c');
    expect(toks[0]?.text).toContain('still a comment');
  });

  // Nothing may be dropped: what the operator copies must be what we were given.
  it('is lossless', () => {
    const code = [
      'local MessagingService = game:GetService("MessagingService")',
      'local TOPIC = "gameapi"',
      '-- comment with "quotes" and 42',
      'local ok, conn = pcall(function()',
      '\treturn MessagingService:SubscribeAsync(TOPIC, function(message)',
      '\t\tprint("[GameApi]", message.Data)',
      '\tend)',
      'end)',
      'if not ok then task.wait(5) end',
    ].join('\n');
    expect(
      tokenizeLuau(code)
        .map((t) => t.text)
        .join(''),
    ).toBe(code);
  });

  it('survives input it was never meant to see', () => {
    for (const junk of ['', '"unterminated', '--', '\n\n', '\\', '[[', '"']) {
      expect(() => tokenizeLuau(junk), JSON.stringify(junk)).not.toThrow();
      expect(
        tokenizeLuau(junk)
          .map((t) => t.text)
          .join(''),
      ).toBe(junk);
    }
  });
});
