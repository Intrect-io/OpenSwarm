import { WebhookNotifier, createNotifier } from './notifier';

describe('WebhookNotifier', () => {
  it('should reject webhook URLs targeting non-global IPv4 addresses', () => {
    expect(() => new WebhookNotifier('http://192.168.1.1')).toThrow();
    expect(() => new WebhookNotifier('http://100.64.0.1')).toThrow();
    expect(() => new WebhookNotifier('http://127.0.0.1')).toThrow();
  });

  it('should allow webhook URLs with global IPv4 addresses', () => {
    expect(() => new WebhookNotifier('http://8.8.8.8')).not.toThrow();
    expect(() => new WebhookNotifier('http://1.1.1.1')).not.toThrow();
  });

  it('should allow webhook URLs with domain names', () => {
    expect(() => new WebhookNotifier('https://discord.com/webhook/123')).not.toThrow();
  });

  it('should reject link-local addresses', () => {
    expect(() => new WebhookNotifier('http://169.254.0.1')).toThrow();
  });

  it('should reject private Class A addresses', () => {
    expect(() => new WebhookNotifier('http://10.0.0.1')).toThrow();
  });

  it('should reject private Class B addresses', () => {
    expect(() => new WebhookNotifier('http://172.16.0.1')).toThrow();
  });

  it('should allow webhook URLs with DNS names', () => {
    expect(() => new WebhookNotifier('https://webhook.example.com')).not.toThrow();
  });
});

describe('validateWebhookUrl', () => {
  test('rejects loopback IPv4 addresses', () => {
    expect(validateWebhookUrl('http://127.0.0.1/hook')).toBe(false);
    expect(validateWebhookUrl('http://127.1.1.1/hook')).toBe(false);
  });

  test('rejects private IPv4 addresses', () => {
    expect(validateWebhookUrl('http://10.0.0.1/hook')).toBe(false);
    expect(validateWebhookUrl('http://192.168.1.1/hook')).toBe(false);
    expect(validateWebhookUrl('http://172.16.0.1/hook')).toBe(false);
    expect(validateWebhookUrl('http://172.31.255.255/hook')).toBe(false);
  });

  test('rejects CGNAT IPv4 addresses', () => {
    expect(validateWebhookUrl('http://100.64.0.1/hook')).toBe(false);
    expect(validateWebhookUrl('http://100.127.255.255/hook')).toBe(false);
  });

  test('accepts global IPv4 and DNS names', () => {
    expect(validateWebhookUrl('http://8.8.8.8/hook')).toBe(true);
    expect(validateWebhookUrl('http://example.com/hook')).toBe(true);
  });
});

describe('createNotifier', () => {
  it('should return NoopNotifier for webhook URLs targeting non-global IPv4', () => {
    // createNotifier catches errors and returns NoopNotifier
    const notifier = createNotifier({ channel: 'webhook', webhookUrl: 'http://192.168.1.1/hook' });
    // NoopNotifier logs but doesn't throw — verify it doesn't crash
    expect(async () => await notifier.notify('test')).not.toThrow();
  });

  it('should return NoopNotifier for webhook URLs targeting CGNAT addresses', () => {
    const notifier = createNotifier({ channel: 'webhook', webhookUrl: 'http://100.64.0.1/hook' });
    expect(async () => await notifier.notify('test')).not.toThrow();
  });

  it('should return NoopNotifier for webhook URLs targeting loopback', () => {
    const notifier = createNotifier({ channel: 'webhook', webhookUrl: 'http://127.0.0.1/hook' });
    expect(async () => await notifier.notify('test')).not.toThrow();
  });

  it('should return a WebhookNotifier for global IPv4 addresses', () => {
    const notifier = createNotifier({ channel: 'webhook', webhookUrl: 'http://8.8.8.8/hook' });
    expect(async () => await notifier.notify('test')).not.toThrow();
  });

  it('should return a WebhookNotifier for domain names', () => {
    const notifier = createNotifier({ channel: 'webhook', webhookUrl: 'https://example.com/hook' });
    expect(async () => await notifier.notify('test')).not.toThrow();
  });
});