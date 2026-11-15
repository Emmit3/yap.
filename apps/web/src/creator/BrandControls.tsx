import { useEffect, useRef, useState } from 'react';
import {
  brandInputSchema,
  type BrandInput,
  type BrandSettings,
  type BrandSnapshot,
} from '@yap/contracts/production';
import { productionApi } from './production-api';

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Brand settings could not be saved. Try again.';
export function BrandControls({
  sessionId,
  onApply,
  onDirty,
}: {
  sessionId: string;
  onApply: (brand: BrandSnapshot | null) => Promise<void>;
  onDirty?: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<BrandSettings | null>(null),
    [draft, setDraft] = useState<BrandInput | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  const dirty = Boolean(
    saved &&
    draft &&
    JSON.stringify(draft) !==
      JSON.stringify({
        name: saved.name,
        font: saved.font,
        inkColor: saved.inkColor,
        paperColor: saved.paperColor,
        accentColor: saved.accentColor,
        endCard: saved.endCard,
      }),
  );
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setDraft(null);
    setError('');
    setNotice('');
    void productionApi
      .brand(controller.signal)
      .then(({ brand }) => {
        setSaved(brand);
        setDraft({
          name: brand.name,
          font: brand.font,
          inkColor: brand.inkColor,
          paperColor: brand.paperColor,
          accentColor: brand.accentColor,
          endCard: brand.endCard,
        });
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(messageOf(failure));
      });
    return () => controller.abort();
  }, [sessionId, reload]);
  function change(patch: Partial<BrandInput>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNotice('');
  }
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  async function save(apply: boolean) {
    if (!saved || !draft) return;
    const parsed = brandInputSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    const value = await productionApi.saveBrand(saved.version, parsed.data);
    setSaved(value.brand);
    if (apply) await onApply(value.snapshot);
    setNotice(
      apply
        ? 'Brand applied to this film. Review a new quote before production.'
        : 'Workspace brand saved. Apply it when this film is ready.',
    );
  }
  return (
    <details className="creator-saved-answers creator-inspector">
      <summary>Brand for this film</summary>
      <p>
        Save a workspace style, then apply a snapshot to this film. Existing approvals and exports
        keep their original brand.
      </p>
      {error && <p role="alert">{error}</p>}
      {!draft || !saved ? (
        <div>
          <p role="status">
            {error
              ? 'Brand settings are unavailable. Reload the studio to try again.'
              : 'Loading brand settings…'}
          </p>
          {error && (
            <button
              type="button"
              className="creator-secondary-button"
              onClick={() => setReload((value) => value + 1)}
            >
              Reload brand settings
            </button>
          )}
        </div>
      ) : (
        <fieldset disabled={busy}>
          <label>
            Brand name
            <input
              value={draft.name}
              maxLength={80}
              onChange={(event) => change({ name: event.target.value })}
            />
          </label>
          <label>
            Film typeface
            <select
              value={draft.font}
              onChange={(event) => change({ font: event.target.value as BrandInput['font'] })}
            >
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
          </label>
          <div className="creator-review-actions">
            <label>
              Text colour
              <input
                type="color"
                value={draft.inkColor}
                onChange={(event) => change({ inkColor: event.target.value })}
              />
            </label>
            <label>
              Paper colour
              <input
                type="color"
                value={draft.paperColor}
                onChange={(event) => change({ paperColor: event.target.value })}
              />
            </label>
            <label>
              Accent colour
              <input
                type="color"
                value={draft.accentColor}
                onChange={(event) => change({ accentColor: event.target.value })}
              />
            </label>
          </div>
          <label>
            Logo
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file)
                  void act(async () => {
                    if (file.size > 8 * 1024 * 1024)
                      throw new Error('Choose a logo smaller than 8 MiB.');
                    const value = await productionApi.uploadLogo(saved.version, file);
                    setSaved(value.brand);
                    setNotice('Logo saved. Apply the brand to include it in this film.');
                  });
              }}
            />
          </label>
          {saved.logo && (
            <div className="creator-review-actions">
              <img
                src={productionApi.logoUrl(saved.logo.sha256)}
                alt="Saved workspace logo"
                width={96}
                height={96}
                style={{ objectFit: 'contain' }}
              />
              <button
                type="button"
                className="creator-secondary-button"
                onClick={() =>
                  void act(async () => {
                    const value = await productionApi.clearLogo(saved.version);
                    setSaved(value.brand);
                    setNotice('Logo removed from workspace settings.');
                  })
                }
              >
                Remove logo
              </button>
            </div>
          )}
          <label className="creator-review-checkbox">
            <input
              type="checkbox"
              checked={draft.endCard.enabled}
              onChange={(event) =>
                change({ endCard: { ...draft.endCard, enabled: event.target.checked } })
              }
            />
            Include an end card inside the film’s final seconds
          </label>
          {draft.endCard.enabled && (
            <>
              <label>
                End card title
                <input
                  value={draft.endCard.title}
                  maxLength={90}
                  onChange={(event) =>
                    change({ endCard: { ...draft.endCard, title: event.target.value } })
                  }
                />
              </label>
              <label>
                Supporting text
                <textarea
                  value={draft.endCard.detail}
                  maxLength={160}
                  onChange={(event) =>
                    change({ endCard: { ...draft.endCard, detail: event.target.value } })
                  }
                />
              </label>
              <label>
                End card seconds
                <input
                  type="number"
                  min={1}
                  max={6}
                  step={0.5}
                  value={draft.endCard.seconds}
                  onChange={(event) =>
                    change({ endCard: { ...draft.endCard, seconds: Number(event.target.value) } })
                  }
                />
              </label>
            </>
          )}
          <div
            aria-label="Brand colour preview"
            style={{
              background: draft.paperColor,
              color: draft.inkColor,
              padding: 24,
              marginTop: 24,
              borderRadius: 8,
            }}
          >
            <strong>{draft.name || 'Your brand'}</strong>
            <p>
              {draft.endCard.enabled
                ? draft.endCard.title || 'Your end card title'
                : 'Your film, in your style.'}
            </p>
            <span
              style={{
                display: 'inline-block',
                width: 48,
                height: 8,
                background: draft.accentColor,
              }}
            />
          </div>
          <div className="creator-review-actions">
            <button
              type="button"
              className="creator-secondary-button"
              onClick={() => void act(() => save(false))}
            >
              Save workspace brand
            </button>
            <button
              type="button"
              className="creator-primary-button"
              onClick={() => void act(() => save(true))}
            >
              Save and apply to film
            </button>
            <button
              type="button"
              className="creator-text-button"
              onClick={() =>
                void act(async () => {
                  await onApply(null);
                  setNotice(
                    'Brand removed from this film. Review its new quote before production.',
                  );
                })
              }
            >
              Remove brand from this film
            </button>
          </div>
        </fieldset>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
