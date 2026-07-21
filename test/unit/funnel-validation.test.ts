import { describe, it, expect } from 'vitest';
import { LogBatchBody, FunnelParams } from '../../src/modules/funnel/funnel.schemas';
import { describeAction } from '../../src/modules/panel/webhook';

const ev = (over: Record<string, unknown> = {}) => ({ playerId: 1234567890, step: 1, ...over });
const parse = (body: unknown) => LogBatchBody.safeParse(body);

/**
 * Both of these shipped as VALIDATION_ERROR against a real game, from the same root cause: this
 * module claims to mirror Roblox's AnalyticsService and was quietly stricter than it. A rule we
 * enforce that Roblox does not is not "extra safety", it is a rejection of data the game already
 * logged successfully on their side.
 */
describe('accepts what Roblox accepts', () => {
  it('takes a funnel name with a space — "Onboarding Farm" is an ordinary Roblox name', () => {
    const r = parse({ funnelName: 'Onboarding Farm', kind: 'custom', events: [ev()] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.funnelName).toBe('Onboarding Farm');
  });

  it('takes the other names that used to fail', () => {
    for (const name of ['Animals Fixed', 'Shop → Checkout', "Player's First Quest", 'Nível 2']) {
      expect(parse({ funnelName: name, kind: 'custom', events: [ev()] }).success, name).toBe(true);
    }
  });

  // Studio's Test > Server + Players hands out UserIds of -1, -2, -3. Rejecting them meant the
  // funnel could not be exercised anywhere except a published game.
  it('takes a negative playerId, which is what Studio test players have', () => {
    for (const playerId of [-1, -2, -3]) {
      const r = parse({ funnelName: 'X', kind: 'custom', events: [ev({ playerId })] });
      expect(r.success, `playerId ${playerId}`).toBe(true);
    }
  });

  it('trims the ends so " Farm" and "Farm" cannot become two funnels', () => {
    const r = parse({ funnelName: '  Onboarding Farm  ', kind: 'custom', events: [ev()] });
    expect(r.success && r.data.funnelName).toBe('Onboarding Farm');
    expect(FunnelParams.safeParse({ gameId: 'g', funnelName: ' X ' }).success).toBe(true);
  });
});

describe('a per-event stepName is accepted, not rejected', () => {
  /**
   * Shipped broken: the client put stepName on every event, the schema was .strict() and did not
   * declare it, so every batch from a funnel with named steps was refused outright. It hid behind
   * the funnelName error until that was fixed, then surfaced immediately.
   *
   * Roblox's own API takes stepName per CALL, so this is the shape a hand-written client naturally
   * sends. Rejecting it was the bug; the redundancy is merely wasteful.
   */
  it('accepts the shape the deployed client sends', () => {
    const r = parse({
      funnelName: 'Onboarding Farm',
      kind: 'custom',
      steps: ['HoeGranted', 'HoeInHotbar'],
      events: [ev({ step: 2, stepName: 'HoeInHotbar' })],
    });
    expect(r.success).toBe(true);
  });

  it('accepts names sent ONLY per event, with no steps array', () => {
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ stepName: 'HoeInHotbar' })] }).success).toBe(true);
  });

  it('still rejects a genuinely unknown key, so a typo is not silently dropped', () => {
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ playerid: 5 })] }).success).toBe(false);
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ stepname: 'x' })] }).success).toBe(false);
  });

  /** 59 named steps x 100 events is where the 16 KB body limit actually gets tested. */
  it('a 59-step funnel fits the body limit with room to spare', () => {
    const steps = Array.from({ length: 59 }, (_, i) => `CollectCoinsInstructionDone${i}`);
    const body = {
      funnelName: 'Onboarding Farm',
      kind: 'custom',
      steps,
      events: Array.from({ length: 100 }, (_, i) => ev({ step: (i % 59) + 1, at: 1784200000 + i, msSincePrev: 4210 })),
    };
    expect(parse(body).success).toBe(true);
    expect(JSON.stringify(body).length).toBeLessThan(16_384);
  });
});

describe('still rejects what would actually break something', () => {
  it('refuses control characters — they would wreck the Discord line and the panel table', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\x00b', '\x1b[31m']) {
      expect(parse({ funnelName: bad, kind: 'custom', events: [ev()] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses an empty or whitespace-only name', () => {
    for (const bad of ['', '   ']) {
      expect(parse({ funnelName: bad, kind: 'custom', events: [ev()] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps the Roblox step bound', () => {
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ step: 101 })] }).success).toBe(false);
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ step: 0 })] }).success).toBe(false);
  });

  /**
   * `at` reaches to_timestamp() and `msSincePrev` a Postgres int4 cast BEFORE the SQL clamp runs,
   * so a finite-but-absurd value (ms sent where seconds were meant) used to 500 instead of being
   * clamped. Bounded in the schema now.
   */
  it('rejects an out-of-range timestamp instead of 500ing on to_timestamp', () => {
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ at: 4_102_444_801 })] }).success).toBe(false);
    // A normal recent unix-seconds value is fine.
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ at: 1_784_200_000 })] }).success).toBe(true);
  });

  it('rejects a msSincePrev that would overflow the int4 column', () => {
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ msSincePrev: 604_800_001 })] }).success).toBe(false);
    expect(parse({ funnelName: 'X', kind: 'custom', events: [ev({ msSincePrev: 4210 })] }).success).toBe(true);
  });

  /**
   * The message the game's log actually shows. "Invalid" — zod's default for a bare .regex() —
   * cost real debugging time: it named no field, so the only way to find the cause was to read
   * the server's source.
   */
  it('says which field is wrong instead of just "Invalid"', () => {
    const r = parse({ funnelName: 'a\nb', kind: 'custom', events: [ev()] });
    expect(r.success).toBe(false);
    const msg = r.success ? '' : r.error.issues[0]!.message;
    expect(msg).not.toBe('Invalid');
    expect(msg).toContain('funnelName');
  });
});

/**
 * A funnel name is chosen by the GAME, so whoever holds a funnel:write key chooses what lands in
 * the Discord channel. Widening the charset made that reachable; these are the two defences.
 */
describe('a funnel name cannot attack the Discord log', () => {
  const textFor = (funnelName: string): string =>
    describeAction({
      method: 'DELETE',
      routeUrl: '/v1/panel/games/:gameId/funnels/:funnelName',
      params: { funnelName },
      body: {},
    })!.text;

  it('escapes markdown so a name cannot reformat the message', () => {
    expect(textFor('**pwned**')).toContain('\\*\\*pwned\\*\\*');
    expect(textFor('a`b')).toContain('a\\`b');
    // The wrapping bold must survive intact.
    expect(textFor('**x**').startsWith('deleted funnel **\\*\\*x\\*\\***')).toBe(true);
  });

  it('leaves an ordinary name alone', () => {
    expect(textFor('Onboarding Farm')).toContain('**Onboarding Farm**');
  });
});

/**
 * The Roblox publish topic/message are FREE-TEXT (no charset regex upstream), unlike the names
 * above. A panel:write holder could put newlines and markdown in them to forge extra log lines
 * attributed to someone else. They must be collapsed to one line and markdown-escaped.
 */
describe('the Roblox publish log line cannot be forged', () => {
  const publish = (topic: string, message: string): string =>
    describeAction({
      method: 'POST',
      routeUrl: '/v1/panel/games/:gameId/roblox/publish',
      params: {},
      body: { topic, message },
    })!.text;

  it('strips newlines so the message cannot become a second forged line', () => {
    const text = publish('Global', 'hi\n\n💥 **admin** deleted this game');
    expect(text).not.toContain('\n');
    // The injected asterisks are neutralised, not rendered as bold.
    expect(text).toContain('\\*\\*admin\\*\\*');
  });

  it('escapes markdown and strips control bytes in the topic', () => {
    const esc = String.fromCharCode(0x1b); // built, not typed, so this file stays plain ASCII
    const text = publish('a`b' + esc + '[31m', 'ok');
    expect(text).toContain('a\\`b'); // backtick neutralised
    expect(text).not.toContain(esc); // the ANSI escape byte is gone
  });

  it('strips Unicode line separators Discord would render as line breaks', () => {
    // U+2028 / U+2029 / U+0085 are line breaks the ASCII control range misses. Built by code point.
    for (const cp of [0x2028, 0x2029, 0x0085]) {
      const sep = String.fromCharCode(cp);
      const text = publish('Global', 'line one' + sep + 'forged **admin** line two');
      expect(text, `U+${cp.toString(16)}`).not.toContain(sep);
      expect(text).toContain('\\*\\*admin\\*\\*');
    }
  });

  it('leaves an ordinary topic and message readable', () => {
    expect(publish('Announcements', 'Server restarting in 5m')).toContain(
      'published to Roblox topic **Announcements**: Server restarting in 5m',
    );
  });
});

/**
 * The round-2 fix hardened only topic/message; two OTHER free-text sinks stayed open — the API-key
 * label (no charset regex, no escaping at all) and the funnel name (FUNNEL_NAME_REGEX permits the
 * Unicode line separators md() can't strip). Both let a privileged caller forge a second log line
 * spoofing another operator. The fix routes EVERY interpolated value through line(); these lock it.
 */
describe('every free-text audit sink is neutralised, not just topic/message', () => {
  it('an API-key label cannot forge a bolded second line', () => {
    const text = describeAction({
      method: 'POST',
      routeUrl: '/v1/panel/games/:gameId/keys',
      params: {},
      body: { label: 'x\n🔑 **victim** PURGED stock key excalibur', scopes: ['stock:read'] },
    })!.text;
    expect(text).not.toContain('\n'); // no forged second line
    expect(text).toContain('\\*\\*victim\\*\\*'); // injected bold is escaped, not rendered
  });

  it('a funnel name with a Unicode line separator cannot forge a line on delete', () => {
    const sep = String.fromCharCode(0x2028); // LINE SEPARATOR — passes FUNNEL_NAME_REGEX
    const text = describeAction({
      method: 'DELETE',
      routeUrl: '/v1/panel/games/:gameId/funnels/:funnelName',
      params: { funnelName: 'Onboarding' + sep + '💥 **admin** deleted everything' },
      body: {},
    })!.text;
    expect(text).not.toContain(sep);
    expect(text).toContain('\\*\\*admin\\*\\*');
  });

  it('a funnel rename displayName is stripped and escaped too', () => {
    const text = describeAction({
      method: 'PATCH',
      routeUrl: '/v1/panel/games/:gameId/funnels/:funnelName',
      params: { funnelName: 'onboarding' },
      body: { displayName: 'nice\n**admin** wiped it' },
    })!.text;
    expect(text).not.toContain('\n');
    expect(text).toContain('\\*\\*admin\\*\\*');
  });
});
