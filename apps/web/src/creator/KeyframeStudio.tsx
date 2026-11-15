import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowsClockwise, Check, ImageSquare, Stop } from '@phosphor-icons/react';
import {
  creatorImageSettingsSchema,
  type CreatorImageLibrary,
  type CreatorImageQuote,
  type CreatorImageSettings,
} from '@yap/contracts/creator-images';
import type { CreatorClip } from '@yap/contracts/creator';
import { creatorApi, creatorMessage, CreatorApiError } from './api';
import { promoApi } from '../promo/api';
import { isActiveJob, planCurrent } from './model';
import { formatUsd } from './quote';
import {
  activeImageJob,
  clearKnownImageRequest,
  clearRejectedImageRequest,
  imageQuoteCurrent,
  imageSubmissionDecision,
  readImageRequest,
  saveImageRequest,
  type SavedImageRequest,
} from './image-workflow';
import type { CreatorController } from './useCreatorSession';
import './keyframes.css';

interface ImageDraft {
  settings: CreatorImageSettings;
  resultId: string | null;
}
type Drafts = Record<string, ImageDraft>;
type DraftTarget = Pick<
  CreatorClip,
  'id' | 'prompt' | 'camera' | 'lighting' | 'assetId' | 'keyframeId'
>;
const emptyLibrary: CreatorImageLibrary = { configured: false, variants: [], jobs: [] };
const defaultDraft = (clip: DraftTarget): ImageDraft => ({
  settings: {
    prompt: `${clip.prompt}\nComposition: ${clip.camera}\nLighting: ${clip.lighting}`.slice(
      0,
      4000,
    ),
    model: 'gpt-image-2.6-flare',
    quality: 'medium',
    size: '864x1536',
    complexity: 'low',
    ...(clip.id === 'creation' ? {} : { clipId: clip.id }),
    ...(clip.keyframeId
      ? { parentVariantId: clip.keyframeId }
      : clip.assetId
        ? { sourceAssetId: clip.assetId }
        : {}),
  },
  resultId: clip.keyframeId ?? null,
});
const draftKey = (id: string) => `yap.creator.image-drafts:${id}`;
function readDrafts(id: string): Drafts {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(draftKey(id)) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([clipId, candidate]) => {
        if (!candidate || typeof candidate !== 'object' || !('settings' in candidate)) return [];
        const settings = creatorImageSettingsSchema.safeParse(candidate.settings);
        if (
          !settings.success ||
          (clipId === 'creation' ? Boolean(settings.data.clipId) : settings.data.clipId !== clipId)
        )
          return [];
        return [
          [
            clipId,
            {
              settings: settings.data,
              resultId:
                'resultId' in candidate && typeof candidate.resultId === 'string'
                  ? candidate.resultId
                  : null,
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

export function KeyframeStudio({
  c,
  selectedShot,
  onSelectShot,
}: {
  c: CreatorController;
  selectedShot: number;
  onSelectShot(index: number): void;
}) {
  return c.state ? (
    <SavedKeyframeStudio
      key={c.state.session.id}
      c={c}
      selectedShot={selectedShot}
      onSelectShot={onSelectShot}
    />
  ) : null;
}

function SavedKeyframeStudio({
  c,
  selectedShot,
  onSelectShot,
}: {
  c: CreatorController;
  selectedShot: number;
  onSelectShot(index: number): void;
}) {
  const state = c.state!;
  const plan = state.session.plan;
  const creationTarget: DraftTarget = {
    id: 'creation',
    prompt: state.session.input.prompt,
    camera: 'A clear portrait composition with the subject fully visible',
    lighting: 'Soft natural light',
    ...(state.workflow.assets[0] ? { assetId: state.workflow.assets[0].id } : {}),
  };
  const clip: DraftTarget = plan ? (plan.clips[selectedShot] ?? plan.clips[0])! : creationTarget;
  const targetFor = (clipId?: string): DraftTarget | undefined =>
    clipId ? plan?.clips.find((item) => item.id === clipId) : creationTarget;
  const [drafts, setDrafts] = useState<Drafts>(() => readDrafts(state.session.id));
  const draft = drafts[clip.id] ?? defaultDraft(clip);
  const [library, setLibrary] = useState<CreatorImageLibrary>(emptyLibrary);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [quote, setQuote] = useState<CreatorImageQuote | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState<SavedImageRequest | null>(null);
  const [display, setDisplay] = useState<'result' | 'compare'>('result');
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const loadSequence = useRef(0);
  const activeJob = library.jobs.find(activeImageJob);
  const blocked =
    Boolean(c.busy) ||
    c.dirty ||
    c.needsReload ||
    isActiveJob(c.job) ||
    Boolean(plan && !planCurrent(state.session, state.workflow));
  const parsed = creatorImageSettingsSchema.safeParse(draft.settings);
  const settings = parsed.success ? parsed.data : null;
  const contextKey = `${state.session.id}:${state.session.version}:${state.workflow.version}:${JSON.stringify(draft.settings)}:${blocked}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const result =
    library.variants.find((variant) => variant.id === draft.resultId) ??
    library.variants.find((variant) => variant.id === clip.keyframeId) ??
    library.variants.find((variant) => variant.id === drafts.creation?.resultId) ??
    null;
  const originalVariantId = result
    ? result.settings.parentVariantId
    : draft.settings.parentVariantId;
  const originalVariant = library.variants.find((variant) => variant.id === originalVariantId);
  const sourceAssetId = result ? result.settings.sourceAssetId : draft.settings.sourceAssetId;
  const originalAsset = state.workflow.assets.find((asset) => asset.id === sourceAssetId);
  const originalUrl = originalVariant
    ? creatorApi.imageUrl(state.session.id, originalVariant.id)
    : originalAsset
      ? promoApi.assetUrl(state.workflow.id, originalAsset.id)
      : null;
  const quoteCurrent = Boolean(
    settings && imageQuoteCurrent(quote, state.session, state.workflow, settings, library, now),
  );
  const requestedVariant = library.variants.find(
    (variant) => variant.id === draft.settings.parentVariantId,
  );
  const requestedAsset = state.workflow.assets.find(
    (asset) => asset.id === draft.settings.sourceAssetId,
  );
  const requestedSourceUrl = requestedVariant
    ? creatorApi.imageUrl(state.session.id, requestedVariant.id)
    : requestedAsset
      ? promoApi.assetUrl(state.workflow.id, requestedAsset.id)
      : null;
  const chosen = result && clip.keyframeId === result.id;
  const editing = Boolean(draft.settings.parentVariantId || draft.settings.sourceAssetId);
  const spendingPaused = Boolean(c.budget?.pausedReason);

  function setDraft(update: (value: ImageDraft) => ImageDraft) {
    setDrafts((previous) => ({
      ...previous,
      [clip.id]: update(previous[clip.id] ?? defaultDraft(clip)),
    }));
  }
  function updateSettings(update: (value: CreatorImageSettings) => CreatorImageSettings) {
    setDraft((previous) => ({ ...previous, settings: update(previous.settings) }));
  }
  function controller() {
    const next = new AbortController();
    requests.current.add(next);
    return next;
  }

  async function refresh(signal?: AbortSignal) {
    const sequence = ++loadSequence.current;
    const value = await creatorApi.images(state.session.id, signal);
    if (!mounted.current || signal?.aborted || sequence !== loadSequence.current) return value;
    setLibrary({
      ...value,
      variants: [...value.variants].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      jobs: [...value.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
    setLoaded(true);
    try {
      const remembered = readImageRequest(localStorage, state.session.id);
      if (remembered && clearKnownImageRequest(localStorage, remembered, value.jobs)) {
        setPending(null);
        const accepted = value.jobs.find((job) => job.requestId === remembered.requestId);
        setQuote((previous) =>
          previous?.id === remembered.quote.id
            ? { ...previous, consumedByJobId: accepted?.id ?? null }
            : previous,
        );
      } else setPending(readImageRequest(localStorage, state.session.id));
    } catch (caught) {
      setStorageWarning(creatorMessage(caught));
    }
    const finished = value.jobs.filter((job) => job.status === 'succeeded' && job.variantId);
    setDrafts((previous) => {
      const next = { ...previous };
      for (const job of [...finished].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const target = targetFor(job.settings.clipId);
        if (!target) continue;
        const existing = next[target.id];
        if (!existing?.resultId)
          next[target.id] = { ...(existing ?? defaultDraft(target)), resultId: job.variantId };
      }
      return next;
    });
    return value;
  }

  useEffect(() => {
    mounted.current = true;
    const active = controller();
    setLoading(true);
    void refresh(active.signal)
      .catch((caught) => {
        if (!active.signal.aborted) setError(creatorMessage(caught));
      })
      .finally(() => {
        requests.current.delete(active);
        if (!active.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      requests.current.forEach((item) => item.abort());
      requests.current.clear();
      c.setImageWorkActive(false);
    };
  }, [state.session.id]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey(state.session.id), JSON.stringify(drafts));
    } catch {
      setStorageWarning(
        'Image prompt drafts could not be saved in this browser. Keep this tab open; paid work requires working browser storage.',
      );
    }
  }, [drafts, state.session.id]);
  useEffect(() => {
    setQuote(null);
    setReviewed(false);
    setError('');
  }, [contextKey]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    c.setImageWorkActive(Boolean(activeJob || operation));
    return () => c.setImageWorkActive(false);
  }, [activeJob?.id, activeJob?.status, operation]);
  useEffect(() => {
    if (!activeJob) return;
    const active = controller();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await creatorApi.imageJob(state.session.id, activeJob.id, active.signal);
        if (active.signal.aborted) return;
        if (activeImageJob(response.job)) {
          setLibrary((previous) => ({
            ...previous,
            jobs: previous.jobs.map((job) => (job.id === response.job.id ? response.job : job)),
          }));
          timer = setTimeout(() => void poll(), 1600);
        } else {
          await refresh(active.signal);
          if (response.job.variantId)
            setDrafts((previous) => {
              const target = targetFor(response.job.settings.clipId);
              if (!target) return previous;
              return {
                ...previous,
                [target.id]: {
                  ...(previous[target.id] ?? defaultDraft(target)),
                  resultId: response.job.variantId,
                },
              };
            });
          setNotice(
            response.job.status === 'succeeded' ? 'Image saved.' : 'Image stopped. See activity.',
          );
        }
      } catch (caught) {
        if (!active.signal.aborted) {
          setError(`Image status could not be refreshed. ${creatorMessage(caught)}`);
          timer = setTimeout(() => void poll(), 4000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active.abort();
      requests.current.delete(active);
      clearTimeout(timer);
    };
  }, [activeJob?.id]);

  async function reviewCost() {
    if (
      !settings ||
      blocked ||
      spendingPaused ||
      activeJob ||
      pending ||
      !library.configured ||
      inFlight.current
    )
      return;
    const captured = currentContext.current;
    const active = controller();
    inFlight.current = true;
    setOperation('Reviewing image cost');
    setError('');
    setNotice('');
    try {
      const fresh = await refresh(active.signal);
      if (fresh.jobs.some(activeImageJob)) return;
      const savedRequest = readImageRequest(localStorage, state.session.id);
      if (savedRequest) {
        setPending(savedRequest);
        throw new Error('Resolve the saved image request before reviewing another cost.');
      }
      const response = await creatorApi.imageQuote(
        state.session.id,
        {
          expectedVersion: state.session.version,
          expectedWorkflowVersion: state.workflow.version,
          settings,
        },
        active.signal,
      );
      if (currentContext.current !== captured || active.signal.aborted) return;
      if (!imageQuoteCurrent(response.quote, state.session, state.workflow, settings, fresh))
        throw new Error(
          'The saved material changed during the quote. Reload the studio and review again.',
        );
      setQuote(response.quote);
      setReviewed(false);
    } catch (caught) {
      if (!active.signal.aborted) setError(creatorMessage(caught));
    } finally {
      requests.current.delete(active);
      inFlight.current = false;
      if (mounted.current) setOperation('');
    }
  }

  async function submit(recordToRecover?: SavedImageRequest) {
    const selectedQuote = recordToRecover?.quote ?? quote;
    if (
      !selectedQuote ||
      blocked ||
      activeJob ||
      inFlight.current ||
      (!recordToRecover && (!reviewed || !quoteCurrent))
    )
      return;
    if (!recordToRecover && spendingPaused) return;
    const captured = currentContext.current;
    const active = controller();
    inFlight.current = true;
    setOperation('Submitting reviewed image');
    setError('');
    setNotice('');
    let submittedRecord: SavedImageRequest | null = null;
    try {
      const fresh = await refresh(active.signal);
      const remembered = readImageRequest(localStorage, state.session.id);
      const decision = imageSubmissionDecision(fresh.jobs, selectedQuote, remembered);
      if (decision.kind === 'existing') {
        setNotice('Showing the saved image job.');
        return;
      }
      if (currentContext.current !== captured)
        throw new Error(
          'Your saved film or image settings changed. Review them again before starting.',
        );
      const record = {
        quote: selectedQuote,
        requestId: decision.requestId ?? recordToRecover?.requestId ?? crypto.randomUUID(),
      };
      saveImageRequest(localStorage, record);
      submittedRecord = record;
      setPending(record);
      const response = await creatorApi.createImage(
        state.session.id,
        {
          expectedVersion: selectedQuote.sessionVersion,
          expectedWorkflowVersion: selectedQuote.workflowVersion,
          quoteId: selectedQuote.id,
          requestId: record.requestId,
          costReviewed: true,
        },
        active.signal,
      );
      if (active.signal.aborted) return;
      setLibrary((previous) => ({
        ...previous,
        jobs: [response.job, ...previous.jobs.filter((job) => job.id !== response.job.id)],
      }));
      clearKnownImageRequest(localStorage, record, [response.job]);
      setPending(null);
      setQuote((previous) =>
        previous?.id === selectedQuote.id
          ? { ...previous, consumedByJobId: response.job.id }
          : previous,
      );
      await refresh(active.signal);
      if (response.job.variantId)
        setDrafts((previous) => {
          const target = targetFor(response.job.settings.clipId);
          return target
            ? {
                ...previous,
                [target.id]: {
                  ...(previous[target.id] ?? defaultDraft(target)),
                  resultId: response.job.variantId,
                },
              }
            : previous;
        });
    } catch (caught) {
      if (!active.signal.aborted && submittedRecord && caught instanceof CreatorApiError) {
        try {
          const fresh = await creatorApi.images(state.session.id, active.signal);
          if (clearRejectedImageRequest(localStorage, submittedRecord, fresh.jobs, caught)) {
            setPending(null);
            setQuote(null);
            setReviewed(false);
            setNotice('Request not accepted. Review a new cost.');
          }
        } catch {
          /* Unknown server state keeps the durable request identity. */
        }
      }
      if (!active.signal.aborted)
        setError(
          `${creatorMessage(caught)} Check saved image activity before starting another request.`,
        );
    } finally {
      requests.current.delete(active);
      inFlight.current = false;
      if (mounted.current) setOperation('');
    }
  }

  async function checkActivity() {
    if (loading || inFlight.current) return;
    setLoading(true);
    setError('');
    const active = controller();
    try {
      await refresh(active.signal);
    } catch (caught) {
      if (!active.signal.aborted) setError(creatorMessage(caught));
    } finally {
      requests.current.delete(active);
      if (mounted.current) setLoading(false);
    }
  }
  async function cancelImage() {
    if (!activeJob || inFlight.current) return;
    const active = controller();
    inFlight.current = true;
    setOperation('Canceling image work');
    try {
      await creatorApi.cancelImage(state.session.id, activeJob.id, active.signal);
      await refresh(active.signal);
      setNotice('Cancellation requested. Submitted work may still be billed.');
    } catch (caught) {
      if (!active.signal.aborted) setError(creatorMessage(caught));
    } finally {
      requests.current.delete(active);
      inFlight.current = false;
      if (mounted.current) setOperation('');
    }
  }
  const inputLocked = blocked || Boolean(operation || activeJob);
  const sourceValue = draft.settings.parentVariantId
    ? `variant:${draft.settings.parentVariantId}`
    : draft.settings.sourceAssetId
      ? `asset:${draft.settings.sourceAssetId}`
      : '';
  const latestTerminal = library.jobs.find(
    (job) => (job.settings.clipId ?? 'creation') === clip.id && !activeImageJob(job),
  );
  return (
    <section
      className="keyframe-studio"
      id="creator-visual-studio"
      aria-labelledby="keyframe-studio-title"
      aria-busy={Boolean(operation || loading)}
    >
      <header className="keyframe-studio-heading">
        <h2 id="keyframe-studio-title" tabIndex={-1}>
          Image
        </h2>
        {plan && (
          <select
            aria-label="Working shot"
            value={clip.id}
            onChange={(event) =>
              onSelectShot(plan.clips.findIndex((item) => item.id === event.target.value))
            }
          >
            {plan.clips.map((item, index) => (
              <option key={item.id} value={item.id}>
                Shot {index + 1}
              </option>
            ))}
          </select>
        )}
      </header>

      {blocked && (
        <p className="keyframe-state-note">
          {c.dirty
            ? 'Save open changes to continue.'
            : 'Finish active work or refresh the saved plan to continue.'}
        </p>
      )}
      {loaded && !library.configured && (
        <details className="keyframe-state-note">
          <summary>Connect OpenAI to create images</summary>
          <p>Add OPENAI_API_KEY to the API server, then restart it.</p>
        </details>
      )}
      {error && (
        <div className="creator-inline-error" role="alert">
          <p>{error}</p>
          <button
            className="creator-text-button"
            disabled={c.dirty || Boolean(operation)}
            onClick={c.reload}
          >
            Reload saved state
          </button>
        </div>
      )}
      {storageWarning && (
        <p className="keyframe-state-note" role="status">
          {storageWarning}
        </p>
      )}
      {notice && (
        <p className="keyframe-notice" role="status">
          {notice}
        </p>
      )}
      {c.budget?.pausedReason && (
        <p className="creator-inline-error" role="alert">
          Paid work paused: {c.budget.pausedReason}
        </p>
      )}

      {pending && (
        <div className="keyframe-recovery" role="status">
          <strong>Check the previous image request</strong>
          <p>{formatUsd(pending.quote.maxCostCents)} maximum. Resume uses its original request.</p>
          <details>
            <summary>Request details</summary>
            <p>{pending.quote.settings.prompt}</p>
            <p>
              {pending.quote.settings.model} · {pending.quote.settings.quality} quality
            </p>
          </details>
          <div className="creator-actions">
            <button
              className="creator-secondary-button"
              disabled={loading || Boolean(operation)}
              onClick={() => void checkActivity()}
            >
              Check status
            </button>
            <button
              className="creator-text-button"
              disabled={inputLocked || !library.configured}
              onClick={() => void submit(pending)}
            >
              Resume request
            </button>
          </div>
        </div>
      )}

      <div className="keyframe-workbench">
        <div className="keyframe-viewer">
          <div className="keyframe-viewer-toolbar">
            <span>{result ? 'Generated image' : 'Preview'}</span>
            <div role="group" aria-label="Image view">
              <button
                className="creator-text-button"
                aria-pressed={display === 'result'}
                onClick={() => setDisplay('result')}
              >
                Result
              </button>
              <button
                className="creator-text-button"
                aria-pressed={display === 'compare'}
                disabled={!result || !originalUrl}
                onClick={() => setDisplay('compare')}
              >
                Compare
              </button>
            </div>
          </div>
          <div
            className={
              'keyframe-canvas' +
              (display === 'compare' && result && originalUrl ? ' is-comparing' : '')
            }
          >
            {display === 'compare' && result && originalUrl && (
              <figure>
                <img src={originalUrl} alt="The actual reference image used for this version" />
                <figcaption>Original</figcaption>
              </figure>
            )}
            {result ? (
              <figure key={result.id}>
                <img
                  src={creatorApi.imageUrl(state.session.id, result.id)}
                  alt={'Generated image: ' + result.settings.prompt.slice(0, 180)}
                  onError={() => setError('Image unavailable. Refresh activity to check it.')}
                />
                {display === 'compare' && originalUrl && <figcaption>Result</figcaption>}
              </figure>
            ) : requestedSourceUrl ? (
              <figure>
                <img src={requestedSourceUrl} alt="Reference selected for the next image request" />
                <figcaption>Reference</figcaption>
              </figure>
            ) : (
              <div className="keyframe-empty">
                <ImageSquare size={40} weight="light" />
                <p role={loading || activeJob ? 'status' : undefined}>
                  {loading
                    ? 'Loading images…'
                    : activeJob
                      ? 'Creating image…'
                      : 'Describe an image to start.'}
                </p>
              </div>
            )}
          </div>
          {result && (
            <div className="keyframe-result-actions">
              <button
                className="creator-primary-button"
                disabled={inputLocked || Boolean(activeJob) || Boolean(chosen)}
                onClick={() => (plan ? c.selectKeyframe(clip.id, result.id) : c.prepare())}
              >
                {chosen ? (
                  <>
                    <Check size={16} />
                    Selected
                  </>
                ) : (
                  <>
                    {plan ? 'Use for this shot' : 'Prepare shots'}
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
              <button
                className="creator-text-button"
                disabled={inputLocked}
                onClick={() => {
                  updateSettings((previous) => {
                    const { sourceAssetId: _asset, ...rest } = previous;
                    return { ...rest, parentVariantId: result.id };
                  });
                  setNotice('');
                  requestAnimationFrame(() => promptInput.current?.focus());
                }}
              >
                Refine
              </button>
              <details className="keyframe-image-details">
                <summary>Details</summary>
                <p>{result.settings.prompt}</p>
                <p>
                  {result.settings.model} · {result.settings.quality} · 864 × 1536
                </p>
                <p>
                  {result.kind === 'edited'
                    ? 'Edited from a saved reference.'
                    : 'Generated from text.'}{' '}
                  Saved {new Date(result.createdAt).toLocaleString()}.
                </p>
                {clip.keyframeId && (
                  <button
                    className="creator-text-button"
                    disabled={inputLocked}
                    onClick={() => c.selectKeyframe(clip.id, null)}
                  >
                    Remove from shot
                  </button>
                )}
              </details>
            </div>
          )}
        </div>

        <div className="keyframe-controls">
          <fieldset disabled={inputLocked}>
            <label className="keyframe-prompt-label">
              {editing ? 'Edit prompt' : 'Prompt'}
              <textarea
                ref={promptInput}
                rows={4}
                value={draft.settings.prompt}
                maxLength={4000}
                onChange={(event) =>
                  updateSettings((previous) => ({ ...previous, prompt: event.target.value }))
                }
                placeholder={editing ? 'What should change?' : 'What should the image show?'}
              />
            </label>
            <details className="keyframe-settings">
              <summary>
                Settings{' '}
                <span>
                  {draft.settings.model === 'gpt-image-2.6-flare' ? 'Flare' : 'Sunburst'} ·{' '}
                  {draft.settings.quality}
                </span>
              </summary>
              <div>
                <label>
                  Reference
                  <select
                    value={sourceValue}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateSettings((previous) => {
                        const {
                          parentVariantId: _parent,
                          sourceAssetId: _asset,
                          ...rest
                        } = previous;
                        return value.startsWith('variant:')
                          ? { ...rest, parentVariantId: value.slice(8) }
                          : value.startsWith('asset:')
                            ? { ...rest, sourceAssetId: value.slice(6) }
                            : rest;
                      });
                    }}
                  >
                    <option value="">Text only</option>
                    {state.workflow.assets.map((asset) => (
                      <option key={asset.id} value={'asset:' + asset.id}>
                        {asset.filename}
                      </option>
                    ))}
                    {library.variants.map((variant, index) => (
                      <option key={variant.id} value={'variant:' + variant.id}>
                        Version {library.variants.length - index}
                      </option>
                    ))}
                  </select>
                </label>
                {requestedSourceUrl && (
                  <figure className="keyframe-source-preview">
                    <img src={requestedSourceUrl} alt="Current image reference" />
                    <figcaption>
                      {requestedVariant ? 'Generated reference' : 'Uploaded reference'}
                    </figcaption>
                  </figure>
                )}
                <div className="keyframe-setting-pair">
                  <label>
                    Model
                    <select
                      value={draft.settings.model}
                      onChange={(event) =>
                        updateSettings((previous) => ({
                          ...previous,
                          model:
                            event.target.value === 'gpt-image-2.6-sunburst'
                              ? 'gpt-image-2.6-sunburst'
                              : 'gpt-image-2.6-flare',
                        }))
                      }
                    >
                      <option value="gpt-image-2.6-flare">GPT Image 2.6 Flare</option>
                      <option value="gpt-image-2.6-sunburst">GPT Image 2.6 Sunburst</option>
                    </select>
                  </label>
                  <label>
                    Quality
                    <select
                      value={draft.settings.quality}
                      onChange={(event) =>
                        updateSettings((previous) => ({
                          ...previous,
                          quality:
                            event.target.value === 'high'
                              ? 'high'
                              : event.target.value === 'low'
                                ? 'low'
                                : 'medium',
                        }))
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </div>
              </div>
            </details>
          </fieldset>
          {(!quote || !quoteCurrent) && !activeJob && (
            <button
              className="creator-primary-button keyframe-create"
              disabled={
                inputLocked ||
                !loaded ||
                !library.configured ||
                !settings ||
                Boolean(pending) ||
                Boolean(storageWarning) ||
                spendingPaused
              }
              onClick={() => void reviewCost()}
            >
              {operation === 'Reviewing image cost'
                ? 'Reviewing…'
                : quote
                  ? 'Review new cost'
                  : 'Review image cost'}
              <ArrowRight size={16} />
            </button>
          )}
          {quote && quoteCurrent && (
            <div className="keyframe-cost-review">
              <label className="keyframe-cost-checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={inputLocked}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I approve up to {formatUsd(quote.maxCostCents)}
              </label>
              <button
                className="creator-primary-button"
                disabled={
                  !reviewed ||
                  inputLocked ||
                  !library.configured ||
                  Boolean(pending) ||
                  Boolean(storageWarning) ||
                  spendingPaused
                }
                onClick={() => void submit()}
              >
                {editing ? 'Edit image' : 'Create image'}
                <ArrowRight size={16} />
              </button>
              <details>
                <summary>Cost details</summary>
                <p>
                  App reservation, not a provider invoice. Expires{' '}
                  {new Date(quote.expiresAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  . Changes require a new quote.
                </p>
              </details>
            </div>
          )}
          {activeJob && (
            <div className="keyframe-active-job" role="status">
              <span>{activeJob.status === 'queued' ? 'Queued…' : 'Creating image…'}</span>
              <button
                className="creator-text-button"
                disabled={Boolean(operation)}
                onClick={() => void cancelImage()}
              >
                <Stop size={15} />
                Cancel
              </button>
              <small>Submitted work may still be billed.</small>
            </div>
          )}
          {latestTerminal?.error && (
            <p className="creator-inline-error" role="alert">
              {latestTerminal.error.message}
            </p>
          )}
          {latestTerminal?.costWarning && (
            <p className="creator-inline-error" role="alert">
              {latestTerminal.costWarning}
            </p>
          )}
        </div>
      </div>

      <div className="keyframe-history-heading">
        <span>{library.variants.length ? 'Versions · ' + library.variants.length : ''}</span>
        <button
          className="creator-icon-button"
          aria-label="Refresh image activity"
          title="Refresh image activity"
          disabled={loading || Boolean(operation)}
          onClick={() => void checkActivity()}
        >
          <ArrowsClockwise size={16} />
        </button>
      </div>
      {!!library.variants.length && (
        <div className="keyframe-history" role="group" aria-label="Saved image versions">
          {library.variants.map((variant, index) => (
            <button
              key={variant.id}
              className="keyframe-version"
              aria-pressed={result?.id === variant.id}
              aria-label={
                'Version ' +
                (library.variants.length - index) +
                (clip.keyframeId === variant.id ? ', selected for this shot' : '')
              }
              onClick={() => {
                setDraft((previous) => ({ ...previous, resultId: variant.id }));
                setDisplay('result');
              }}
            >
              <img src={creatorApi.imageUrl(state.session.id, variant.id)} alt="" loading="lazy" />
              <span>
                {library.variants.length - index}
                {clip.keyframeId === variant.id ? ' ✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      <details className="keyframe-job-history">
        <summary>Activity{library.jobs.length ? ' · ' + library.jobs.length : ''}</summary>
        {library.jobs.length ? (
          <ul>
            {[...library.jobs]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((job) => (
                <li key={job.id}>
                  <strong>
                    {job.status} ·{' '}
                    {job.settings.model === 'gpt-image-2.6-flare' ? 'Flare' : 'Sunburst'}
                  </strong>
                  <span>
                    {formatUsd(job.maxCostCents)} ceiling ·{' '}
                    {new Date(job.createdAt).toLocaleString()}
                  </span>
                  {job.error && <p>{job.error.message}</p>}
                  {job.costWarning && <p role="alert">{job.costWarning}</p>}
                  {job.reportedCostCents !== undefined && (
                    <small>Usage estimate: {formatUsd(job.reportedCostCents)}.</small>
                  )}
                  <small>
                    {job.submittedAt
                      ? 'Submitted work may still be billed after cancellation.'
                      : 'Not submitted to the provider.'}
                  </small>
                </li>
              ))}
          </ul>
        ) : (
          <p>No image jobs yet.</p>
        )}
      </details>
    </section>
  );
}
