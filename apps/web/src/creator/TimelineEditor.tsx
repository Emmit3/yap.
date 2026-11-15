import { useEffect, useRef, useState } from 'react';
import {
  editDraftSchema,
  editDuration,
  type EditDocument,
  type EditDraft,
} from '@yap/contracts/production';
import { productionApi } from './production-api';
import { fetchCreatorVideo } from './downloads';

export function TimelineEditor({
  sessionId,
  jobId,
  onDirty,
}: {
  sessionId: string;
  jobId: string;
  onDirty?: (dirty: boolean) => void;
}) {
  const [edits, setEdits] = useState<EditDocument[]>([]),
    [selected, setSelected] = useState<EditDocument | null>(null),
    [draft, setDraft] = useState<EditDraft | null>(null);
  const [history, setHistory] = useState<Array<{ version: number; draft: EditDraft }>>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [reviewed, setReviewed] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const dirty = Boolean(
    selected && draft && JSON.stringify(selected.draft) !== JSON.stringify(draft),
  );
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  const duration = draft ? editDuration(draft) : 0;
  const output = selected
    ? [...selected.renders].reverse().find((render) => render.editVersion === selected.version)
    : undefined;
  useEffect(() => {
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setSelected(null);
    setDraft(null);
    setEdits([]);
    setError('');
    setNotice('');
    setLoading(true);
    setBusy(false);
    setReviewed(false);
    setHistory([]);
    void productionApi
      .list(sessionId, controller.signal)
      .then(({ edits: saved }) => {
        const matching = saved.filter((edit) => edit.base.jobId === jobId);
        setEdits(matching);
        const first = matching[0] ?? null;
        setSelected(first);
        setDraft(first?.draft ?? null);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Saved edits could not load.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          active.current = null;
        }
      });
    return () => {
      controller.abort();
      active.current?.abort();
      active.current = null;
    };
  }, [sessionId, jobId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function choose(edit: EditDocument) {
    setSelected(edit);
    setDraft(structuredClone(edit.draft));
    setHistory([]);
    setReviewed(false);
    setError('');
    setNotice('');
  }
  function accept(edit: EditDocument) {
    setEdits((current) => [edit, ...current.filter((old) => old.id !== edit.id)]);
    choose(edit);
  }
  function change(next: EditDraft) {
    setDraft(next);
    setReviewed(false);
    setError('');
    setNotice('');
  }
  async function act(operation: (signal: AbortSignal) => Promise<void>) {
    if (busy || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'The edit could not finish.');
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  async function save(signal: AbortSignal) {
    if (!selected || !draft) return;
    const parsed = editDraftSchema.safeParse(draft);
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((issue) => issue.message).join(' '));
    const value = await productionApi.save(
      sessionId,
      selected.id,
      selected.version,
      parsed.data,
      signal,
    );
    signal.throwIfAborted();
    accept(value.edit);
    setNotice(`Edit version ${value.edit.version} saved.`);
  }
  function move(index: number, delta: number) {
    if (!draft) return;
    const segments = [...draft.segments],
      target = index + delta;
    [segments[index], segments[target]] = [segments[target]!, segments[index]!];
    change({ ...draft, segments });
  }
  return (
    <details className="creator-saved-answers creator-inspector">
      <summary>Edit the finished film</summary>
      <p>
        Trim and reorder copies of the approved clips, add transitions and text, then review a free
        local render. Sound and burned subtitles move with each slice. A manual cut can shorten a
        spoken word. Saved cuts snap to video frames.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Loading saved edits…</p>
      ) : (
        <>
          <div className="creator-review-actions">
            <button
              type="button"
              className="creator-secondary-button"
              disabled={busy || dirty}
              onClick={() =>
                void act(async (signal) => {
                  const value = await productionApi.create(sessionId, jobId, signal);
                  signal.throwIfAborted();
                  accept(value.edit);
                })
              }
            >
              Start another edit from the original
            </button>
            {edits.length > 0 && (
              <label>
                Saved edit
                <select
                  disabled={busy || dirty}
                  value={selected?.id ?? ''}
                  onChange={(event) => {
                    const next = edits.find((edit) => edit.id === event.target.value);
                    if (next) choose(next);
                  }}
                >
                  {edits.map((edit, index) => (
                    <option key={edit.id} value={edit.id}>
                      Edit {edits.length - index} · version {edit.version}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {selected && draft && (
            <>
              <p>
                <strong>{duration.toFixed(2)} seconds</strong> · saved version {selected.version}
                {dirty ? ' · unsaved changes' : ''}
              </p>
              <fieldset disabled={busy}>
                <legend>Clip order and trim</legend>
                <ol>
                  {draft.segments.map((segment, index) => {
                    const source = selected.base.clips.find(
                      (clip) => clip.id === segment.sourceClipId,
                    )!;
                    const update = (patch: Partial<typeof segment>) =>
                      change({
                        ...draft,
                        segments: draft.segments.map((item) =>
                          item.id === segment.id ? { ...item, ...patch } : item,
                        ),
                      });
                    return (
                      <li key={segment.id} style={{ marginTop: 24 }}>
                        <fieldset>
                          <legend>Clip {index + 1}</legend>
                          <label>
                            Start within original clip, seconds
                            <input
                              type="number"
                              min={0}
                              max={source.end - source.start}
                              step={0.05}
                              value={segment.trimIn}
                              onChange={(event) => update({ trimIn: Number(event.target.value) })}
                            />
                          </label>
                          <label>
                            End within original clip, seconds
                            <input
                              type="number"
                              min={0.25}
                              max={source.end - source.start}
                              step={0.05}
                              value={segment.trimOut}
                              onChange={(event) => update({ trimOut: Number(event.target.value) })}
                            />
                          </label>
                          {index < draft.segments.length - 1 && (
                            <>
                              <label>
                                Transition to next clip
                                <select
                                  value={segment.transition}
                                  onChange={(event) =>
                                    update({
                                      transition:
                                        event.target.value === 'dissolve' ? 'dissolve' : 'cut',
                                    })
                                  }
                                >
                                  <option value="cut">Cut</option>
                                  <option value="dissolve">Dissolve with sound fade</option>
                                </select>
                              </label>
                              {segment.transition === 'dissolve' && (
                                <label>
                                  Dissolve seconds
                                  <input
                                    type="number"
                                    min={0.1}
                                    max={1}
                                    step={0.1}
                                    value={segment.transitionSeconds}
                                    onChange={(event) =>
                                      update({ transitionSeconds: Number(event.target.value) })
                                    }
                                  />
                                </label>
                              )}
                            </>
                          )}
                          <div className="creator-review-actions">
                            <button
                              type="button"
                              className="creator-secondary-button"
                              disabled={index === 0}
                              aria-label={`Move clip ${index + 1} earlier`}
                              onClick={() => move(index, -1)}
                            >
                              Move earlier
                            </button>
                            <button
                              type="button"
                              className="creator-secondary-button"
                              disabled={index === draft.segments.length - 1}
                              aria-label={`Move clip ${index + 1} later`}
                              onClick={() => move(index, 1)}
                            >
                              Move later
                            </button>
                            <button
                              type="button"
                              className="creator-text-button"
                              disabled={draft.segments.length === 1}
                              onClick={() =>
                                change({
                                  ...draft,
                                  segments: draft.segments.filter((item) => item.id !== segment.id),
                                })
                              }
                            >
                              Remove clip
                            </button>
                          </div>
                        </fieldset>
                      </li>
                    );
                  })}
                </ol>
                <fieldset style={{ marginTop: 24 }}>
                  <legend>Text layers</legend>
                  {draft.textLayers.map((layer, index) => {
                    const update = (patch: Partial<typeof layer>) =>
                      change({
                        ...draft,
                        textLayers: draft.textLayers.map((item) =>
                          item.id === layer.id ? { ...item, ...patch } : item,
                        ),
                      });
                    return (
                      <fieldset key={layer.id} style={{ marginTop: 24 }}>
                        <legend>Text {index + 1}</legend>
                        <label>
                          Your text
                          <textarea
                            value={layer.text}
                            maxLength={160}
                            onChange={(event) => update({ text: event.target.value })}
                          />
                        </label>
                        <label>
                          Show from, seconds
                          <input
                            type="number"
                            min={0}
                            max={duration}
                            step={0.1}
                            value={layer.start}
                            onChange={(event) => update({ start: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          Show until, seconds
                          <input
                            type="number"
                            min={0.1}
                            max={duration}
                            step={0.1}
                            value={layer.end}
                            onChange={(event) => update({ end: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          Placement
                          <select
                            value={layer.y < 0.35 ? 'top' : layer.y > 0.65 ? 'bottom' : 'middle'}
                            onChange={(event) =>
                              update({
                                x: 0.5,
                                y:
                                  event.target.value === 'top'
                                    ? 0.2
                                    : event.target.value === 'bottom'
                                      ? 0.8
                                      : 0.5,
                              })
                            }
                          >
                            <option value="top">Top</option>
                            <option value="middle">Middle</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </label>
                        <label>
                          Text size
                          <input
                            type="number"
                            min={24}
                            max={80}
                            value={layer.fontSize}
                            onChange={(event) => update({ fontSize: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          Text colour
                          <input
                            type="color"
                            value={layer.color}
                            onChange={(event) => update({ color: event.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="creator-text-button"
                          onClick={() =>
                            change({
                              ...draft,
                              textLayers: draft.textLayers.filter((item) => item.id !== layer.id),
                            })
                          }
                        >
                          Remove text
                        </button>
                      </fieldset>
                    );
                  })}
                  <button
                    type="button"
                    className="creator-secondary-button"
                    disabled={draft.textLayers.length >= 24}
                    onClick={() =>
                      change({
                        ...draft,
                        textLayers: [
                          ...draft.textLayers,
                          {
                            id: crypto.randomUUID(),
                            text: '',
                            start: 0,
                            end: Math.min(3, duration),
                            x: 0.5,
                            y: 0.2,
                            fontSize: 48,
                            color: '#ffffff',
                          },
                        ],
                      })
                    }
                  >
                    Add text
                  </button>
                </fieldset>
                <label className="creator-review-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.brand)}
                    onChange={(event) => {
                      if (event.target.checked)
                        void act(async (signal) => {
                          const value = await productionApi.brand(signal);
                          signal.throwIfAborted();
                          change({ ...draft, brand: value.snapshot });
                        });
                      else change({ ...draft, brand: null });
                    }}
                  />
                  Apply the current workspace brand to this edit
                </label>
                <div className="creator-review-actions">
                  <button
                    type="button"
                    className="creator-primary-button"
                    disabled={!dirty}
                    onClick={() => void act(save)}
                  >
                    Save edit version
                  </button>
                  <button
                    type="button"
                    className="creator-text-button"
                    onClick={() =>
                      void act(async (signal) => {
                        const value = await productionApi.get(sessionId, selected.id, signal);
                        signal.throwIfAborted();
                        accept(value.edit);
                        setNotice('Saved version reloaded. Local changes were discarded.');
                      })
                    }
                  >
                    Discard local changes and reload
                  </button>
                  <button
                    type="button"
                    className="creator-secondary-button"
                    disabled={dirty}
                    onClick={() =>
                      void act(async (signal) => {
                        const value = await productionApi.history(sessionId, selected.id, signal);
                        signal.throwIfAborted();
                        setHistory(value.history);
                      })
                    }
                  >
                    Show saved versions
                  </button>
                </div>
                {history.length > 0 && (
                  <label>
                    Restore a saved version
                    <select
                      defaultValue=""
                      onChange={(event) => {
                        const revision = history.find(
                          (item) => item.version === Number(event.target.value),
                        );
                        if (revision) change(structuredClone(revision.draft));
                      }}
                    >
                      <option value="" disabled>
                        Choose a version to review
                      </option>
                      {history.map((revision) => (
                        <option key={revision.version} value={revision.version}>
                          Version {revision.version}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="creator-review-checkbox">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={dirty}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  I reviewed this saved edit, its timing and text.
                </label>
                <button
                  type="button"
                  className="creator-primary-button"
                  disabled={dirty || !reviewed}
                  onClick={() =>
                    void act(async (signal) => {
                      await productionApi.render(sessionId, selected.id, selected.version, signal);
                      const value = await productionApi.get(sessionId, selected.id, signal);
                      signal.throwIfAborted();
                      accept(value.edit);
                      setNotice('Edited film rendered and verified.');
                    })
                  }
                >
                  {busy ? 'Rendering locally…' : 'Render reviewed edit'}
                </button>
              </fieldset>
              {output && !dirty && (
                <section aria-label="Edited film preview">
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={productionApi.videoUrl(sessionId, selected.id, output.id)}
                    style={{ display: 'block', width: '100%', maxHeight: 640, marginTop: 24 }}
                  />
                  <button
                    type="button"
                    className="creator-secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void act(async (signal) => {
                        const blob = await fetchCreatorVideo(
                          productionApi.videoUrl(sessionId, selected.id, output.id, true),
                          output,
                          signal,
                        );
                        signal.throwIfAborted();
                        const url = URL.createObjectURL(blob),
                          link = document.createElement('a');
                        link.href = url;
                        link.download = 'yap-edited-film.mp4';
                        document.body.append(link);
                        try {
                          link.click();
                        } finally {
                          link.remove();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }
                        setNotice('Verified edited film download requested.');
                      })
                    }
                  >
                    Download edited film
                  </button>
                </section>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
