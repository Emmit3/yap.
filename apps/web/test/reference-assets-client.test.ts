import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createReferenceAssetsApi } from '../src/creator/reference-assets-api.js';

const sessionId = randomUUID(),
  frameId = randomUUID(),
  referenceId = randomUUID();
const quote = {
  id: randomUUID(),
  sessionId,
  sessionVersion: 3,
  workflowVersion: 8,
  prompt: 'A calm studio frame.',
  promptHash: 'a'.repeat(64),
  inputHash: 'b'.repeat(64),
  purpose: 'storyboard' as const,
  model: 'gpt-image-2-2026-04-21' as const,
  size: '1024x1536' as const,
  quality: 'medium' as const,
  currency: 'USD' as const,
  maxCostCents: 10 as const,
  priceSourceUrl: 'https://developers.openai.com/api/docs/guides/image-generation' as const,
  pricingCheckedAt: '2026-11-15T00:00:00.000Z',
  createdAt: '2026-11-15T00:00:00.000Z',
  expiresAt: '2026-11-15T00:10:00.000Z',
};
test('storyboard client binds current versions, exact quote and durable generation request', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const requestId = randomUUID();
  const api = createReferenceAssetsApi('https://api.example', async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith('/quote')) return Response.json({ quote });
    return Response.json({
      image: {
        id: frameId,
        sessionId,
        quoteId: quote.id,
        requestId,
        inputHash: quote.inputHash,
        promptHash: quote.promptHash,
        prompt: quote.prompt,
        purpose: 'storyboard',
        model: quote.model,
        attempt: 1,
        status: 'running',
        createdAt: quote.createdAt,
        updatedAt: quote.createdAt,
      },
    });
  });
  await api.quoteImage(
    { sessionId, sessionVersion: 3, workflowVersion: 8 },
    { prompt: quote.prompt, purpose: 'storyboard' },
  );
  const input = {
    sessionVersion: 3,
    workflowVersion: 8,
    quoteId: quote.id,
    requestId,
    reviewed: true as const,
    costReviewed: true as const,
  };
  await api.generateImage(sessionId, input);
  await api.generateImage(sessionId, input);
  assert.deepEqual(requests[0]!.body, {
    prompt: quote.prompt,
    purpose: 'storyboard',
    sessionVersion: 3,
    workflowVersion: 8,
  });
  assert.deepEqual(requests[1]!.body, requests[2]!.body);
  assert.equal(
    api.imageUrl(sessionId, frameId),
    `https://api.example/api/creator/sessions/${sessionId}/images/${frameId}/image`,
  );
});
test('reference client preserves structured API errors and rejects malformed saved records', async () => {
  const refused = createReferenceAssetsApi('', async () =>
    Response.json(
      { error: { code: 'REFERENCE_ANALYSIS_SOURCE_CHANGED', message: 'The source changed.' } },
      { status: 409 },
    ),
  );
  await assert.rejects(
    () => refused.references(sessionId),
    (error) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'REFERENCE_ANALYSIS_SOURCE_CHANGED',
  );
  const malformed = createReferenceAssetsApi('', async () =>
    Response.json({ references: [{ id: 'invalid' }], configured: true }),
  );
  await assert.rejects(() => malformed.references(sessionId));
  assert.equal(
    malformed.frameUrl(sessionId, referenceId, frameId),
    `/api/creator/sessions/${sessionId}/reference-analysis/${referenceId}/frames/${frameId}/image`,
  );
});
