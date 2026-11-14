import express from 'express';
import { ApiError } from './errors.js';
import { posterContextRequestSchema } from '@yap/contracts/posters';
import { PosterReferenceLibrary, type PosterReferenceOptions } from './poster-references.js';

export function createPosterRouter(options: PosterReferenceOptions = {}) {
  const router = express.Router();
  const library = new PosterReferenceLibrary(options);
  router.get('/references', async (_request, response) => {
    response.json({ references: await library.list() });
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
  router.post('/context', async (request, response) => {
    const parsed = posterContextRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'POSTER_VALIDATION',
        'Supply a poster prompt and one to three unique reference IDs.',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    response.json(await library.context(parsed.data));
  });
  return router;
}
