import express from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { createPosterDesignSchema } from '@yap/contracts/posters';
import { PosterReferenceLibrary, type PosterReferenceOptions } from './poster-references.js';
import { PosterDesignRepository } from './poster-designs.js';

export interface PosterRouterOptions extends PosterReferenceOptions {
  dataFile?: string;
}

export function createPosterRouter(options: PosterRouterOptions = {}) {
  const router = express.Router();
  const library = new PosterReferenceLibrary(options);
  const designs = new PosterDesignRepository(
    options.dataFile ?? resolve('data/poster-designs.json'),
  );
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.get('/styles', async (_request, response) => {
    response.json({ styles: await library.styles() });
  });
  router.get('/references/:id/image', async (request, response) => {
    const hash = request.query.sha256;
    if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
      throw new ApiError(
        400,
        'POSTER_VALIDATION',
        'Use the image URL supplied by the reference catalog.',
      );
    const image = await library.readImage(request.params.id, hash);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type(image.mimeType).send(image.data);
  });
  router.post('/designs', async (request, response) => {
    const parsed = createPosterDesignSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'POSTER_VALIDATION',
        'Choose a current poster style and describe what you would like to add.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    const design = await designs.create(await library.prepare(parsed.data));
    response.status(201).location(`/api/posters/designs/${design.id}`).json({ design });
  });
  router.get('/designs/:id', async (request, response) => {
    const parsed = z.uuid().safeParse(request.params.id);
    if (!parsed.success)
      throw new ApiError(400, 'POSTER_VALIDATION', 'Use a valid saved poster design ID.');
    response.json({ design: await designs.get(parsed.data) });
  });
  router.all(['/references', '/context'], (_request, _response) => {
    throw new ApiError(404, 'NOT_FOUND', 'This API route could not be found.');
  });
  return router;
}
