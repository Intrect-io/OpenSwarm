import { WebhookNotifier } from './notifier';

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

  describe('Webhook URL validation', () => {
    test('rejects private IPv4 addresses', () => {
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('172.16.0.1')).toBe(true);
      expect(isPrivateIPv4('192.168.1.1')).toBe(true);
      expect(isPrivateIPv4('100.64.0.1')).toBe(true);
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('169.254.0.1')).toBe(true);
    });

    test('accepts public IPv4 addresses', () => {
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    });

    test('validates webhook URLs correctly', () => {
      expect(WebhookNotifier.isValidUrl('https://example.com/webhook')).toBe(true);
      expect(WebhookNotifier.isValidUrl('http://example.com/webhook')).toBe(false);
      expect(WebhookNotifier.isValidUrl('https://192.168.1.1/webhook')).toBe(false);
      expect(WebhookNotifier.isValidUrl('https://100.64.0.1/webhook')).toBe(false);
      expect(WebhookNotifier.isValidUrl('https://127.0.0.1/webhook')).toBe(false);
      expect(WebhookNotifier.isValidUrl('https://8.8.8.8/webhook')).toBe(true);
    });

    test('constructor throws for invalid URLs', () => {
      expect(() => new WebhookNotifier('http://example.com')).toThrow();
      expect(() => new WebhookNotifier('https://192.168.1.1')).toThrow();
      expect(() => new WebhookNotifier('https://100.64.0.1')).toThrow();
      expect(() => new WebhookNotifier('https://127.0.0.1')).toThrow();
    });
  });
});
