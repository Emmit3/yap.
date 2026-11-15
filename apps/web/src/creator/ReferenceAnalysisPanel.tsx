import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ReferenceAnalysis, ReferenceImport } from '@yap/contracts/reference-assets';
import { creatorMessage } from './api';
import { referenceAssetsApi as api } from './reference-assets-api';

export function ReferenceAnalysisPanel(props: {
  sessionId: string;
  onUseReference?: (reference: ReferenceAnalysis) => Promise<void>;
  onDirty?: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  return <ReferenceAnalysisSession key={props.sessionId} {...props} />;
}

function ReferenceAnalysisSession({
  sessionId,
  onUseReference,
  onDirty,
  disabled = false,
}: {
  sessionId: string;
  onUseReference?: (reference: ReferenceAnalysis) => Promise<void>;
  onDirty?: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId(),
    requestId = useRef<string | undefined>(undefined),
    dirtyHandler = useRef(onDirty);
  dirtyHandler.current = onDirty;
  const [references, setReferences] = useState<ReferenceAnalysis[]>([]),
    [selected, setSelected] = useState(''),
    [configured, setConfigured] = useState(false);
  const [title, setTitle] = useState(''),
    [sourceUrl, setSourceUrl] = useState(''),
    [format, setFormat] = useState<ReferenceImport['format']>('vtt'),
    [transcript, setTranscript] = useState('');
  const [atSeconds, setAtSeconds] = useState(0),
    [note, setNote] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [costReviewed, setCostReviewed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [framePending, setFramePending] = useState(false);
  const dirty = Boolean(
    title.trim() || sourceUrl.trim() || transcript.trim() || note.trim() || framePending,
  );
  useEffect(() => {
    dirtyHandler.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyHandler.current?.(false), []);
  const reference = references.find((item) => item.id === selected);
  const saved = (record: ReferenceAnalysis) => {
    setReferences((previous) => [record, ...previous.filter((item) => item.id !== record.id)]);
    setSelected(record.id);
  };
  useEffect(() => {
    const controller = new AbortController();
    setReferences([]);
    setSelected('');
    setError('');
    void api
      .references(sessionId, controller.signal)
      .then((result) => {
        setReferences(result.references);
        setConfigured(result.configured);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(creatorMessage(error));
      });
    return () => controller.abort();
  }, [sessionId]);
  useEffect(() => {
    setReviewed(false);
    setCostReviewed(false);
    requestId.current = crypto.randomUUID();
  }, [reference?.id, reference?.sourceHash]);
  async function importTranscript(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      saved(await api.importReference(sessionId, { title, sourceUrl, format, transcript }));
      setTitle('');
      setSourceUrl('');
      setTranscript('');
      setFormat('vtt');
      setNotice('Attributed transcript saved separately from your facts and media.');
    } catch (error) {
      setError(creatorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (!reference) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Use an image under 5 MB.');
      return;
    }
    setBusy(true);
    setFramePending(true);
    setError('');
    try {
      saved(await api.addFrame(sessionId, reference.id, reference.version, atSeconds, file));
      setNotice('Timestamped reference frame saved.');
    } catch (error) {
      setError(creatorMessage(error));
    } finally {
      setFramePending(false);
      setBusy(false);
    }
  }
  async function addNote() {
    if (!reference || !note.trim()) return;
    setBusy(true);
    setError('');
    try {
      saved(await api.addObservation(sessionId, reference.id, reference.version, note, atSeconds));
      setNote('');
      setNotice('Your observation is labeled as a manual note.');
    } catch (error) {
      setError(creatorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function analyze() {
    if (!reference || !reviewed || !costReviewed || !requestId.current) return;
    setBusy(true);
    setError('');
    try {
      saved(
        await api.analyze(sessionId, reference.id, {
          expectedVersion: reference.version,
          sourceHash: reference.sourceHash,
          requestId: requestId.current,
          reviewed: true,
          costReviewed: true,
          maxCostCents: 50,
        }),
      );
      setNotice('Sampled frame analysis saved with its model, source snapshot and limitations.');
      setReviewed(false);
      setCostReviewed(false);
    } catch (error) {
      setError(creatorMessage(error));
      await api
        .references(sessionId)
        .then((result) => {
          setReferences(result.references);
          setConfigured(result.configured);
        })
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="creator-reference-assets" aria-labelledby={`${id}-title`}>
      <fieldset disabled={disabled} aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`}>Understand a reference</h3>
        <p>
          Import a transcript and upload the moments you want to inspect. Reference material informs
          creative choices and remains separate from your own facts and production media.
        </p>
        {error && (
          <p className="creator-notice" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="creator-notice" role="status">
            {notice}
          </p>
        )}
        <form onSubmit={importTranscript}>
          <label htmlFor={`${id}-name`}>
            Reference title
            <input
              id={`${id}-name`}
              value={title}
              maxLength={200}
              required
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label htmlFor={`${id}-source`}>
            Original source page
            <input
              id={`${id}-source`}
              type="url"
              value={sourceUrl}
              required
              disabled={busy}
              placeholder="https://example.com/film"
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </label>
          <label htmlFor={`${id}-format`}>
            Transcript format
            <select
              id={`${id}-format`}
              value={format}
              disabled={busy}
              onChange={(event) => setFormat(event.target.value as ReferenceImport['format'])}
            >
              <option value="vtt">WebVTT</option>
              <option value="srt">SRT</option>
              <option value="plain">Timed plain text</option>
            </select>
          </label>
          <label htmlFor={`${id}-file`}>
            Or load a transcript file
            <input
              id={`${id}-file`}
              type="file"
              accept=".vtt,.srt,.txt,text/vtt,text/plain"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 64000) {
                  setError('Keep transcript files under 64 KB.');
                  return;
                }
                void file
                  .text()
                  .then((text) => {
                    setTranscript(text);
                    if (file.name.endsWith('.srt')) setFormat('srt');
                    else if (file.name.endsWith('.vtt')) setFormat('vtt');
                  })
                  .catch((error) => setError(creatorMessage(error)));
              }}
            />
          </label>
          <label htmlFor={`${id}-transcript`}>
            Timed transcript
            <textarea
              id={`${id}-transcript`}
              value={transcript}
              maxLength={64000}
              rows={5}
              required
              disabled={busy}
              placeholder={'00:00:01.000 --> 00:00:04.000\nThe opening line.'}
              onChange={(event) => setTranscript(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Save attributed transcript
          </button>
        </form>
        {references.length > 0 && (
          <label htmlFor={`${id}-selected`}>
            Saved reference
            <select
              id={`${id}-selected`}
              value={selected}
              disabled={busy}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Choose a reference</option>
              {references.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {reference && (
          <div>
            <p>
              <a href={reference.sourceUrl} target="_blank" rel="noreferrer">
                Original source
              </a>{' '}
              · {reference.cues.length} supplied transcript cues · {reference.frames.length} of 8
              sampled frames
            </p>
            <label htmlFor={`${id}-seconds`}>
              Moment in the reference, seconds
              <input
                id={`${id}-seconds`}
                type="number"
                min={0}
                max={7200}
                step="0.1"
                value={atSeconds}
                disabled={busy}
                onChange={(event) => setAtSeconds(Number(event.target.value))}
              />
            </label>
            <label htmlFor={`${id}-frame`}>
              Upload a still from that moment
              <input
                id={`${id}-frame`}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy || reference.frames.length >= 8}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = '';
                }}
              />
            </label>
            <div className="creator-asset-grid">
              {reference.frames.map((frame) => (
                <figure key={frame.id}>
                  <img
                    src={api.frameUrl(sessionId, reference.id, frame.id)}
                    alt={`${reference.title} at ${frame.atSeconds} seconds`}
                    loading="lazy"
                    width={frame.width}
                    height={frame.height}
                  />
                  <figcaption>{frame.atSeconds}s · uploaded reference sample</figcaption>
                </figure>
              ))}
            </div>
            <label htmlFor={`${id}-note`}>
              Your observation
              <textarea
                id={`${id}-note`}
                value={note}
                maxLength={2000}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <button type="button" disabled={busy || !note.trim()} onClick={() => void addNote()}>
              Save manual observation
            </button>
            <div className="creator-cost-review">
              <p>
                AI analysis of the uploaded samples costs up to <strong>$0.50 USD</strong>. It
                cannot inspect moments you have not supplied.
              </p>
              {!configured && (
                <p className="creator-notice">
                  AI visual analysis is not connected. Transcript imports and your manual
                  observations remain available.
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I reviewed the transcript, source and uploaded frames.
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={costReviewed}
                  disabled={busy}
                  onChange={(event) => setCostReviewed(event.target.checked)}
                />
                I approve up to $0.50 for this analysis.
              </label>
              <button
                type="button"
                disabled={
                  busy || !configured || !reference.frames.length || !reviewed || !costReviewed
                }
                onClick={() => void analyze()}
              >
                Analyze approved samples
              </button>
              {reference.requests.some(
                (item) => item.sourceHash === reference.sourceHash && item.status === 'failed',
              ) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    requestId.current = crypto.randomUUID();
                    setReviewed(false);
                    setCostReviewed(false);
                    setNotice(
                      'Review the source and cost again before starting another manual attempt.',
                    );
                  }}
                >
                  Review another analysis attempt
                </button>
              )}
            </div>
            {reference.analysis && (
              <div>
                <h4>Sampled frame analysis</h4>
                <p>{reference.analysis.summary}</p>
                <p className="creator-muted">
                  {reference.analysis.model} ·{' '}
                  {new Date(reference.analysis.analyzedAt).toLocaleString()}
                </p>
                <ul>
                  {reference.analysis.limitations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {reference.observations.length > 0 && (
              <ul>
                {reference.observations.map((item, index) => (
                  <li key={`${index}-${item.origin}`}>
                    <strong>
                      {item.origin === 'ai' ? 'AI sample observation' : 'Your observation'}
                    </strong>
                    {item.atSeconds === undefined ? '' : ` · ${item.atSeconds}s`}: {item.text}
                  </li>
                ))}
              </ul>
            )}
            {onUseReference && (
              <button
                type="button"
                disabled={busy || !reference.observations.length}
                onClick={() => {
                  setBusy(true);
                  void onUseReference(reference)
                    .then(() =>
                      setNotice(
                        'Selected reference observations added as attributed creative context.',
                      ),
                    )
                    .catch((error) => setError(creatorMessage(error)))
                    .finally(() => setBusy(false));
                }}
              >
                Use these reference observations
              </button>
            )}
          </div>
        )}
      </fieldset>
    </section>
  );
}
