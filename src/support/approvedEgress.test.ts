import { describe, expect, it } from 'vitest';
import { approvedLocalModelEndpoint, prepareApprovedLocalModelRequest, prepareApprovedModelRequest } from './approvedEgress.js';

describe('prepareApprovedModelRequest', () => {
  it('serializes a request only for an approved HTTPS provider endpoint', () => {
    expect(prepareApprovedModelRequest(
      'https://api.openai.com/v1/chat/completions',
      { messages: [{ role: 'user', content: 'hello' }] },
    )).toEqual({
      url: 'https://api.openai.com/v1/chat/completions',
      body: '{"messages":[{"role":"user","content":"hello"}]}',
    });
  });

  it('rejects arbitrary and non-HTTPS endpoints', () => {
    expect(() => prepareApprovedModelRequest('https://example.invalid/v1', {})).toThrow('unapproved endpoint');
    expect(() => prepareApprovedModelRequest('http://api.openai.com/v1/chat/completions', {})).toThrow('unapproved endpoint');
  });

  it('allows local model requests only to loopback OpenAI-compatible servers', () => {
    expect(prepareApprovedLocalModelRequest('http://127.0.0.1:1234', { model: 'local-model' })).toEqual({
      url: 'http://127.0.0.1:1234/v1/chat/completions',
      body: '{"model":"local-model"}',
    });

    expect(() => prepareApprovedLocalModelRequest('https://models.example.com', {})).toThrow('unapproved local endpoint');
    expect(() => prepareApprovedLocalModelRequest('http://localhost:1234/proxy', {})).toThrow('unapproved local endpoint');
    expect(() => prepareApprovedLocalModelRequest('file:///tmp/model', {})).toThrow('unapproved local endpoint');
  });

  it('uses the same loopback boundary for local API-key model probes', () => {
    expect(approvedLocalModelEndpoint('http://localhost:1234', '/v1/models')).toBe('http://localhost:1234/v1/models');
    expect(() => approvedLocalModelEndpoint('https://models.example.com', '/v1/models')).toThrow('unapproved local endpoint');
  });
});
