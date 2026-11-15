import express, { type Request } from 'express';
import { z } from 'zod';
import {
  creatorImageQuoteRequestSchema,
  creatorImageStartSchema,
} from '@yap/contracts/creator-images';
import { CreatorImageJobs, type CreatorImageJobsOptions } from './creator-image-jobs.js';
import { ApiError } from './errors.js';

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'CREATOR_IMAGE_VALIDATION',
      'Check the image request settings.',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  return parsed.data;
}
const idOf = (request: Request, key = 'id') => validate(z.uuid(), request.params[key]);

export async function createCreatorImagesRouter(options: CreatorImageJobsOptions) {
  const jobs = new CreatorImageJobs(options);
  const router = express.Router();
  router.get('/sessions/:id/images', async (request, response) => {
    const id = idOf(request);
    const [variants, imageJobs] = await Promise.all([
      options.repository.imageVariants(id),
      options.repository.imageJobs(id),
    ]);
    response.json({ configured: options.provider.configured, variants, jobs: imageJobs });
  });
  router.post('/sessions/:id/images/quote', async (request, response) => {
    const quote = await jobs.quote(
      idOf(request),
      validate(creatorImageQuoteRequestSchema, request.body),
    );
    response.json({ quote });
  });
  router.post('/sessions/:id/images/jobs', async (request, response) => {
    const job = await jobs.start(idOf(request), validate(creatorImageStartSchema, request.body));
    response.status(202).json({ job });
  });
  router.get('/sessions/:id/images/jobs/:jobId', async (request, response) => {
    response.json({
      job: await options.repository.imageJob(idOf(request), idOf(request, 'jobId')),
    });
  });
  router.delete('/sessions/:id/images/jobs/:jobId', async (request, response) => {
    response.json({ job: await jobs.cancel(idOf(request), idOf(request, 'jobId')) });
  });
  router.get('/sessions/:id/images/:variantId/file', async (request, response) => {
    const sessionId = idOf(request),
      variantId = idOf(request, 'variantId');
    const variant = await options.repository.imageVariant(sessionId, variantId);
    response
      .type(variant.media.mimeType)
      .set('Cache-Control', 'private, no-store')
      .set('X-Content-Type-Options', 'nosniff')
      .send(await jobs.load(sessionId, variantId));
  });
  return {
    router,
    load: (sessionId: string, variantId: string) => jobs.load(sessionId, variantId),
    close: () => jobs.close(),
  };
}
