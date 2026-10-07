import { describe, expect, it, vi } from 'vitest';
import { AiServiceError } from '../../src/ai/contracts.js';
import {
  createFoundryStepGenerator,
  FOUNDRY_TOKEN_SCOPE,
  normalizeFoundryEndpoint,
} from '../../src/ai/foundry-generator.js';

const valid = JSON.stringify([
  { title: 'One', description: 'First detail' },
  { title: 'Two', description: 'Second detail' },
  { title: 'Three', description: 'Third detail' },
]);

function clientWith(contents: Array<string | Error>) {
  const create = vi.fn(async (_body: unknown, options?: { signal?: AbortSignal }) => {
    const next = contents.shift();
    if (next instanceof Error) throw next;
    return { choices: [{ message: { content: next } }], signal: options?.signal };
  });
  return { chat: { completions: { create } }, create };
}

describe('Foundry step generator', () => {
  it.each([
    ['https://example.openai.azure.com', 'https://example.openai.azure.com/openai/v1/'],
    ['https://example.openai.azure.com/', 'https://example.openai.azure.com/openai/v1/'],
    ['https://example.openai.azure.com/openai/v1', 'https://example.openai.azure.com/openai/v1/'],
    ['https://example.openai.azure.com/openai/v1/', 'https://example.openai.azure.com/openai/v1/'],
  ])('normalizes Foundry endpoint variant %s to openai v1', (input, expected) => {
    expect(normalizeFoundryEndpoint(input)).toBe(expected);
  });

  it('succeeds after one invalid model response and one valid retry', async () => {
    const client = clientWith(['not json', valid]);
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.test',
      deployment: 'gpt-5-mini',
      client,
    });
    await expect(generator.generate('Ship feature')).resolves.toHaveLength(3);
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it('retries output with fewer than three steps and fails after the second attempt', async () => {
    const tooFew = JSON.stringify([
      { title: 'One', description: 'First' },
      { title: 'Two', description: 'Second' },
    ]);
    const client = clientWith([tooFew, tooFew]);
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.test',
      deployment: 'gpt-5-mini',
      client,
    });
    await expect(generator.generate('Ship feature')).rejects.toBeInstanceOf(AiServiceError);
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it('throws AiServiceError after two invalid model answers', async () => {
    const client = clientWith(['invalid', 'still invalid']);
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.test',
      deployment: 'gpt-5-mini',
      client,
    });
    await expect(generator.generate('Ship feature')).rejects.toBeInstanceOf(AiServiceError);
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it('aborts a timed out model request before starting its retry', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const create = vi.fn(async (_body: unknown, options?: { signal?: AbortSignal }) => {
      calls += 1;
      const signal = options?.signal as AbortSignal;
      signals.push(signal);
      if (calls === 1) {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            expect(calls).toBe(1);
            reject(new Error('aborted'));
          });
        });
      }
      return { choices: [{ message: { content: valid } }] };
    });
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.test',
      deployment: 'gpt-5-mini',
      client: { chat: { completions: { create } } },
      timeoutMs: 5,
    });
    await expect(generator.generate('Ship feature')).resolves.toHaveLength(3);
    expect(signals[0].aborted).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('applies a 30 second abort signal to every model request', async () => {
    vi.useFakeTimers();
    const client = clientWith(['bad', valid]);
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.test',
      deployment: 'gpt-5-mini',
      client,
    });
    const generation = generator.generate('Ship feature');
    await vi.runAllTimersAsync();
    await generation;
    for (const call of client.create.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(call[1]?.signal.aborted).toBe(false);
    }
    vi.useRealTimers();
  });

  it('sends the supported gpt-5 chat completion request fields', async () => {
    const client = clientWith([valid]);
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.test',
      deployment: 'gpt-5-mini',
      client,
    });
    await generator.generate('Ship feature');
    const body = client.create.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: expect.stringContaining('Respond with ONLY a valid JSON array') },
        { role: 'user', content: 'Ship feature' },
      ],
      max_completion_tokens: 1500,
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('authenticates with a Microsoft Entra bearer token and sends no API key', async () => {
    const getToken = vi.fn(async (_scopes: string | string[], _options?: unknown) => ({ token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 }));
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const generator = createFoundryStepGenerator({
      endpoint: 'https://example.openai.azure.com',
      deployment: 'gpt-5-mini',
      credential: { getToken },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(generator.generate('Ship feature')).resolves.toHaveLength(3);
    expect([getToken.mock.calls[0][0]].flat()).toEqual([FOUNDRY_TOKEN_SCOPE]);
    expect(requests[0].url).toBe('https://example.openai.azure.com/openai/v1/chat/completions');
    expect(requests[0].headers.get('authorization')).toBe('Bearer entra-token');
    expect(requests[0].headers.get('api-key')).toBeNull();
  });

  it('throws AiServiceError when AZURE_AI_ENDPOINT is empty', async () => {
    const generator = createFoundryStepGenerator({ endpoint: '', deployment: 'gpt-5-mini' });
    await expect(generator.generate('Ship feature')).rejects.toBeInstanceOf(AiServiceError);
  });
});
