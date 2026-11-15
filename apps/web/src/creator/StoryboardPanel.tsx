import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { CreatorImageJob, CreatorImageQuote } from '@yap/contracts/reference-assets';
import { creatorMessage } from './api';
import { referenceAssetsApi as api } from './reference-assets-api';

export function StoryboardPanel(props: {
  sessionId: string;
  onSelect: (frameId: string) => Promise<void>;
  onDirty?: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  return <StoryboardSession key={props.sessionId} {...props} />;
}

function StoryboardSession({
  sessionId,
  onSelect,
  onDirty,
  disabled = false,
}: {
  sessionId: string;
  onSelect: (frameId: string) => Promise<void>;
  onDirty?: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId(),
    requestId = useRef<string | undefined>(undefined),
    dirtyHandler = useRef(onDirty);
  dirtyHandler.current = onDirty;
  const [images, setImages] = useState<CreatorImageJob[]>([]),
    [configured, setConfigured] = useState(false);
  const [prompt, setPrompt] = useState(''),
    [purpose, setPurpose] = useState<'storyboard' | 'keyframe'>('storyboard'),
    [parent, setParent] = useState('');
  const [quote, setQuote] = useState<CreatorImageQuote | null>(null),
    [reviewed, setReviewed] = useState(false),
    [costReviewed, setCostReviewed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [savedDraft, setSavedDraft] = useState('');
  const draft = JSON.stringify({ prompt, purpose, parent });
  const dirty = Boolean(prompt.trim()) && draft !== savedDraft;
  useEffect(() => {
    dirtyHandler.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyHandler.current?.(false), []);
  const invalidate = () => {
    setQuote(null);
    setReviewed(false);
    setCostReviewed(false);
    requestId.current = undefined;
  };
  const refresh = async (signal?: AbortSignal) => {
    const result = await api.images(sessionId, signal);
    setImages(result.images);
    setConfigured(result.configured);
  };
  useEffect(() => {
    const controller = new AbortController();
    setImages([]);
    invalidate();
    setError('');
    void refresh(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setError(creatorMessage(error));
    });
    return () => controller.abort();
  }, [sessionId]);
  useEffect(() => {
    if (!images.some((image) => image.status === 'running')) return;
    const controller = new AbortController(),
      timer = setInterval(() => void refresh(controller.signal).catch(() => {}), 1500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [sessionId, images]);
  async function requestQuote(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    invalidate();
    try {
      const context = await api.context(sessionId);
      setQuote(
        await api.quoteImage(context, {
          prompt,
          purpose,
          ...(parent ? { parentFrameId: parent } : {}),
        }),
      );
      requestId.current = crypto.randomUUID();
    } catch (error) {
      setError(creatorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    if (!quote || !reviewed || !costReviewed || !requestId.current) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.generateImage(sessionId, {
        sessionVersion: quote.sessionVersion,
        workflowVersion: quote.workflowVersion,
        quoteId: quote.id,
        requestId: requestId.current,
        reviewed: true,
        costReviewed: true,
      });
      setSavedDraft(draft);
      await refresh();
      if (result.status === 'failed')
        setError(
          result.error?.message ??
            'The image did not complete. Request a new quote before manually retrying.',
        );
      else
        setNotice(
          result.status === 'succeeded'
            ? 'Generated frame saved. Choose it explicitly before using it in production.'
            : 'The image request is saved and is still running.',
        );
    } catch (error) {
      setError(creatorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="creator-reference-assets" aria-labelledby={`${id}-title`}>
      <fieldset disabled={disabled} aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`}>Storyboard frames</h3>
        <p>
          Generate an original photographic frame, then choose it as a production reference. Every
          request needs its own cost review.
        </p>
        {!configured && (
          <p className="creator-notice">
            Image generation is not connected. Saved frames remain available.
          </p>
        )}
        {error && (
          <p role="alert" className="creator-notice">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="creator-notice">
            {notice}
          </p>
        )}
        <form onSubmit={requestQuote}>
          <label htmlFor={`${id}-prompt`}>
            Describe the frame
            <textarea
              id={`${id}-prompt`}
              value={prompt}
              maxLength={2000}
              required
              disabled={busy}
              onChange={(event) => {
                setPrompt(event.target.value);
                invalidate();
              }}
              rows={4}
            />
          </label>
          <label htmlFor={`${id}-purpose`}>
            Purpose
            <select
              id={`${id}-purpose`}
              value={purpose}
              disabled={busy}
              onChange={(event) => {
                setPurpose(event.target.value as 'storyboard' | 'keyframe');
                invalidate();
              }}
            >
              <option value="storyboard">Storyboard</option>
              <option value="keyframe">Video keyframe</option>
            </select>
          </label>
          <label htmlFor={`${id}-parent`}>
            Related earlier frame
            <select
              id={`${id}-parent`}
              value={parent}
              disabled={busy}
              onChange={(event) => {
                setParent(event.target.value);
                invalidate();
              }}
            >
              <option value="">New direction</option>
              {images
                .filter((image) => image.status === 'succeeded')
                .map((image) => (
                  <option key={image.id} value={image.id}>
                    {image.prompt.slice(0, 70)}
                  </option>
                ))}
            </select>
          </label>
          <p className="creator-muted">
            An earlier frame records the creative lineage. This request generates from your text; it
            does not edit the earlier image.
          </p>
          <button type="submit" disabled={busy || !configured || !prompt.trim()}>
            Review image cost
          </button>
        </form>
        {quote && (
          <div className="creator-cost-review">
            <p>
              <strong>Up to ${(quote.maxCostCents / 100).toFixed(2)} USD</strong> for one 1024 ×
              1536 PNG. OpenAI {quote.model}, medium quality. API usage is billed separately from a
              ChatGPT subscription.
            </p>
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                disabled={busy}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              I reviewed this exact prompt and image purpose.
            </label>
            <label>
              <input
                type="checkbox"
                checked={costReviewed}
                disabled={busy}
                onChange={(event) => setCostReviewed(event.target.checked)}
              />
              I approve the displayed maximum cost.
            </label>
            <button
              type="button"
              disabled={busy || !reviewed || !costReviewed}
              onClick={() => void generate()}
            >
              {busy ? 'Generating frame…' : 'Generate approved frame'}
            </button>
          </div>
        )}
        <div className="creator-asset-grid">
          {images.map((image) => (
            <article key={image.id} className="creator-asset">
              {image.status === 'succeeded' && image.output && (
                <img
                  src={api.imageUrl(sessionId, image.id)}
                  alt={image.prompt}
                  loading="lazy"
                  width={1024}
                  height={1536}
                />
              )}
              <p>{image.prompt}</p>
              <p className="creator-muted">
                {image.status} · {image.purpose} · attempt {image.attempt} of 2
              </p>
              {image.error && <p>{image.error.message}</p>}
              {image.status === 'succeeded' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError('');
                    void onSelect(image.id)
                      .then(() => setNotice('Generated frame added to this creation.'))
                      .catch((error) => setError(creatorMessage(error)))
                      .finally(() => setBusy(false));
                  }}
                >
                  Use this frame
                </button>
              )}
            </article>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
