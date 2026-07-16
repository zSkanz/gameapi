import { describe, it, expect, vi, afterEach } from 'vitest';
import { publish, TOPIC_MAX, MESSAGE_MAX } from '../../src/modules/panel/roblox';
import { describeAction } from '../../src/modules/panel/webhook';

const cfg = { gameId: 'g', universeId: '123456', apiKey: 'oc_secret_key_value' };

/** Stub fetch and record what each call went to. */
function stubFetch(...responses: { status: number; body?: string }[]) {
  const calls: { url: string; body: unknown; apiKey: string | undefined }[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      calls.push({ url, body: JSON.parse(String(init.body)), apiKey: h['x-api-key'] });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return {
        status: r.status,
        ok: r.status === 200,
        text: async () => r.body ?? '',
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Open Cloud publish', () => {
  it('uses the documented v2 endpoint and body shape', async () => {
    const calls = stubFetch({ status: 200 });
    const out = await publish(cfg, 'my-topic', 'hello');
    expect(out).toEqual({ ok: true, status: 200, api: 'v2', error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://apis.roblox.com/cloud/v2/universes/123456:publishMessage');
    // v2 moved the topic OFF the URL and into the body — that is the whole difference from v1.
    expect(calls[0]!.body).toEqual({ topic: 'my-topic', message: 'hello' });
    expect(calls[0]!.apiKey).toBe(cfg.apiKey);
  });

  it('falls back to v1 only when v2 answers like it does not exist', async () => {
    const calls = stubFetch({ status: 404 }, { status: 200 });
    const out = await publish(cfg, 'my-topic', 'hello');
    expect(out).toEqual({ ok: true, status: 200, api: 'v1', error: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://apis.roblox.com/messaging-service/v1/universes/123456/topics/my-topic');
    expect(calls[1]!.body).toEqual({ message: 'hello' }); // v1 keeps the topic in the URL
  });

  // A bad key is a real answer from a live endpoint. Retrying it against v1 burns the rate
  // limit and replaces Roblox's actual reason with a second, more confusing one.
  it('does NOT fall back on an auth or rate-limit answer', async () => {
    for (const status of [401, 403, 429, 500]) {
      const calls = stubFetch({ status, body: '{"message":"Invalid API key"}' });
      const out = await publish(cfg, 't', 'm');
      expect(out.ok, `status ${status}`).toBe(false);
      expect(out.api, `status ${status}`).toBe('v2');
      expect(calls, `status ${status} must not retry`).toHaveLength(1);
    }
  });

  it("surfaces Roblox's own message, and never the api key", async () => {
    stubFetch({ status: 401, body: '{"message":"Invalid API key"}' });
    const out = await publish(cfg, 't', 'm');
    expect(out.error).toBe('HTTP 401: Invalid API key');
    expect(out.error).not.toContain(cfg.apiKey);
  });

  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND apis.roblox.com'); }));
    const out = await publish(cfg, 't', 'm');
    expect(out).toMatchObject({ ok: false, status: 0, api: null });
    expect(out.error).toContain('ENOTFOUND');
  });

  // Roblox's documented caps. Ours must match or we send requests that cannot succeed.
  it('mirrors the documented Roblox limits', () => {
    expect(TOPIC_MAX).toBe(80);
    expect(MESSAGE_MAX).toBe(1024);
  });
});

describe('the Open Cloud key never reaches Discord', () => {
  it('describes the connection update without its body', () => {
    const a = describeAction({
      method: 'PUT',
      routeUrl: '/v1/panel/games/:gameId/roblox',
      params: {},
      body: { universeId: '123456', apiKey: 'oc_SUPER_SECRET' },
    });
    expect(a!.text).toBe('updated the Roblox connection');
    expect(JSON.stringify(a)).not.toContain('oc_SUPER_SECRET');
  });

  it('logs a published message, which is the operator\'s own text', () => {
    const a = describeAction({
      method: 'POST',
      routeUrl: '/v1/panel/games/:gameId/roblox/publish',
      params: {},
      body: { topic: 'announcements', message: 'Event starting!' },
    });
    expect(a!.text).toContain('announcements');
    expect(a!.text).toContain('Event starting!');
  });
});
