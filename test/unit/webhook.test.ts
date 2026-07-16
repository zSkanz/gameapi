import { describe, it, expect } from 'vitest';
import { assertSafeWebhookUrl, describeAction, maskWebhookUrl } from '../../src/modules/panel/webhook';
import { AppError } from '../../src/core/errors/app-error';

const reject = async (url: string): Promise<string> => {
  const err = await assertSafeWebhookUrl(url).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `${url} should have been refused`).toBeInstanceOf(AppError);
  return (err as AppError).message;
};

describe('webhook URL safety', () => {
  // Any https host is allowed by choice (Slack, n8n, a self-hosted endpoint), so this is the
  // only thing between a compromised panel account and the VPS's internal network.
  it('refuses addresses that point back into our own network', async () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://172.16.0.9/hook',
      'https://169.254.169.254/latest/meta-data/', // cloud metadata — the classic SSRF target
      'https://[::1]/hook',
      // v4-mapped v6. The URL parser rewrites these to hex (::ffff:7f00:1), so a check that
      // only knows the dotted spelling lets loopback through — this caught exactly that.
      'https://[::ffff:127.0.0.1]/hook',
      'https://[::ffff:10.0.0.5]/hook',
      'https://[::ffff:169.254.169.254]/hook',
    ]) {
      expect(await reject(url)).toMatch(/not reachable/);
    }
  });

  it('refuses anything that is not plain https', async () => {
    expect(await reject('http://discord.com/api/webhooks/1/abc')).toMatch(/https/);
    expect(await reject('ftp://discord.com/x')).toMatch(/https/);
    expect(await reject('not a url')).toMatch(/valid URL/);
    // Credentials in the URL would be sent to whatever the host resolves to.
    expect(await reject('https://user:pw@discord.com/api/webhooks/1/abc')).toMatch(/credentials/);
  });

  it('allows a real Discord webhook', async () => {
    await expect(assertSafeWebhookUrl('https://discord.com/api/webhooks/123/abcdef')).resolves.toBeUndefined();
  });

  // The URL is a bearer credential: whoever has it can post as you.
  it('never renders the secret path back to the browser', () => {
    const masked = maskWebhookUrl('https://discord.com/api/webhooks/123456/SUPER-SECRET-TOKEN');
    expect(masked).not.toContain('SUPER-SECRET-TOKEN');
    expect(masked).not.toContain('123456');
    expect(masked).toBe('https://discord.com/…');
  });
});

describe('what reaches Discord', () => {
  const d = (method: string, routeUrl: string, params = {}, body: unknown = {}) =>
    describeAction({ method, routeUrl, params, body });

  it('reads the request body, never the response', () => {
    // The response to this route carries the full API key. The request carries a label.
    const a = d('POST', '/v1/panel/games/:gameId/keys', {}, { label: 'main', scopes: ['stock:read'] });
    expect(a!.text).toContain('main');
    expect(a!.text).toContain('stock:read');
    expect(a!.text).not.toMatch(/gk_/);
  });

  it('describes the actions an operator actually cares about', () => {
    expect(d('DELETE', '/v1/panel/games/:gameId/stock/:stockKey', { stockKey: 'excalibur' })!.text).toContain(
      'deleted stock key **excalibur**',
    );
    expect(d('POST', '/v1/panel/games/:gameId/stock/:stockKey/purge', { stockKey: 'excalibur' })!.text).toContain('PURGED');
    expect(d('POST', '/v1/panel/games/:gameId/stock/:stockKey/adjust', { stockKey: 'sword' }, { delta: -50 })!.text).toContain(
      'adjusted **sword** by -50',
    );
    expect(d('PUT', '/v1/panel/games/:gameId/stock/:stockKey/stock', { stockKey: 'sword' }, { stock: 3000 })!.text).toContain(
      'set **sword** stock to 3,000',
    );
    expect(d('POST', '/v1/panel/games/:gameId/keys/:keyId/revoke', { keyId: 'gk_abc' })!.text).toContain('revoked');
  });

  // A route added next month should appear in the log that day, not the day someone
  // remembers to teach this function about it.
  it('falls back to method and path for a route it does not know', () => {
    const a = d('POST', '/v1/panel/games/:gameId/something-new');
    expect(a).not.toBeNull();
    expect(a!.text).toBe('POST /games/:gameId/something-new');
  });
});
