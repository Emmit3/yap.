import { useEffect, useRef, useState } from 'react';
import type { CreatorJob, CreatorPromptReview } from '@yap/contracts/creator';
import { creatorApi, creatorMessage } from './api';
import { isActiveJob } from './model';
import {
  promptReviewMatches,
  savedPromptContext,
  stageClipRevision,
  type SavedPromptContext,
} from './quality';
import type { CreatorController } from './useCreatorSession';
import './quality.css';

export function PromptReview({
  c,
  clipId,
  disabled,
}: {
  c: CreatorController;
  clipId: string;
  disabled: boolean;
}) {
  const context = savedPromptContext(
    c.state?.session,
    c.state?.workflow,
    disabled || c.dirty || c.needsReload || isActiveJob(c.job),
  );
  const key = context ? JSON.stringify(context) : null;
  const latest = useRef(context);
  latest.current = context;
  const request = useRef<AbortController | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [result, setResult] = useState<{
    context: SavedPromptContext;
    review: CreatorPromptReview;
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    setLoadingKey(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [key]);

  async function reviewSaved() {
    const requested = latest.current;
    if (!requested || request.current) return;
    const active = new AbortController();
    const requestedKey = JSON.stringify(requested);
    request.current = active;
    setLoadingKey(requestedKey);
    setError(null);
    setResult(null);
    try {
      const review = await creatorApi.reviewPlan(requested.sessionId, active.signal);
      if (!active.signal.aborted && request.current === active) {
        if (promptReviewMatches(review, requested, latest.current))
          setResult({ context: requested, review });
        else if (JSON.stringify(latest.current) === requestedKey)
          setError({
            key: requestedKey,
            message:
              'The saved plan changed during this review. Reload the studio, then review again.',
          });
      }
    } catch (caught) {
      if (
        !active.signal.aborted &&
        request.current === active &&
        JSON.stringify(latest.current) === requestedKey
      )
        setError({ key: requestedKey, message: creatorMessage(caught) });
    } finally {
      if (request.current === active) {
        request.current = null;
        setLoadingKey(null);
      }
    }
  }

  const review =
    result && promptReviewMatches(result.review, result.context, context) ? result.review : null;
  const clip = review?.clips.find((item) => item.clipId === clipId);
  const loading = key !== null && loadingKey === key;
  return (
    <section className="creator-prompt-review" aria-label="Saved prompt review" aria-busy={loading}>
      <h4>Check before generation</h4>
      <p className="creator-fineprint">
        Inspect the exact saved prompt and fix conflicting instructions before paying for a clip.
      </p>
      <button
        type="button"
        className="creator-secondary-button"
        disabled={!context || loading}
        onClick={() => void reviewSaved()}
      >
        {loading ? 'Reviewing saved prompts…' : 'Review saved prompts'}
      </button>
      {!context && (
        <p className="creator-fineprint">
          Save all edits and finish any active run first. If this plan is out of date, prepare it
          again.
        </p>
      )}
      {loading && (
        <p className="creator-fineprint" role="status">
          Checking this saved version. No generation starts.
        </p>
      )}
      {error && error.key === key && (
        <p className="creator-inline-error" role="alert">
          {error.message}
        </p>
      )}
      {clip && (
        <div className="creator-prompt-review-result">
          <p role="status">
            {clip.issues.some((issue) => issue.severity === 'blocking')
              ? 'Fix this shot’s blocking issues before production.'
              : clip.issues.length
                ? 'Review these suggestions before production.'
                : 'No prompt conflicts were found for this shot.'}
          </p>
          {review?.hasBlockingIssues &&
            !clip.issues.some((issue) => issue.severity === 'blocking') && (
              <p>Another shot needs a fix. Review its prompt before production.</p>
            )}
          {!!clip.issues.length && (
            <ul className="creator-quality-findings">
              {clip.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <strong>{issue.severity === 'blocking' ? 'Needs a fix' : 'Review'}: </strong>
                  {issue.message}
                  <p>{issue.suggestion}</p>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>Exact prompt for this saved shot</summary>
            <pre className="creator-compiled-prompt">{clip.compiledPrompt}</pre>
          </details>
          <p className="creator-fineprint">
            This checks instructions, not finished-video quality. You still review and approve the
            current plan and quote.
          </p>
        </div>
      )}
    </section>
  );
}

const findingNames: Record<string, string> = {
  subject: 'Subject and product',
  prompt: 'Requested action',
  camera: 'Camera movement',
  lighting: 'Lighting',
  artifacts: 'Visual artifacts',
  continuity: 'Continuity',
  unwanted_text: 'Unwanted text',
};

export function ClipQualityFindings({
  c,
  job,
  receipt,
  onStage,
}: {
  c: CreatorController;
  job: CreatorJob;
  receipt: CreatorJob['clips'][number];
  onStage(clipId: string): void;
}) {
  const [staged, setStaged] = useState(false);
  const audit = receipt.audit;
  const revision = audit?.suggestedRevision;
  const blocked = Boolean(c.busy) || c.dirty || c.needsReload || isActiveJob(c.job);
  const stagedPlan = revision
    ? stageClipRevision(
        c.plan,
        c.state?.session,
        c.state?.workflow,
        job,
        receipt.clipId,
        receipt.attempt,
        blocked,
      )
    : null;
  const draftClip = c.plan?.clips.find((clip) => clip.id === receipt.clipId);
  const stagedStillApplied =
    staged &&
    c.planDirty &&
    revision &&
    draftClip?.prompt === revision.prompt &&
    draftClip?.camera === revision.camera &&
    draftClip?.lighting === revision.lighting;
  useEffect(() => setStaged(false), [job.id, receipt.attempt, c.state?.session.plan?.id]);
  if (!audit) return null;
  return (
    <div className="creator-clip-quality">
      {!!audit.findings?.length && (
        <ul className="creator-quality-findings">
          {audit.findings.map((finding, index) => (
            <li key={`${finding.category}-${index}`}>
              <strong>
                {findingNames[finding.category] ?? finding.category}
                {finding.severity === 'blocking' ? ' · Needs a fix' : ' · Review'}
              </strong>
              <p>{finding.observation}</p>
              <p>Suggested fix: {finding.suggestedFix}</p>
              {!!finding.frameIndices.length && (
                <small>
                  Sampled frames {finding.frameIndices.map((frame) => frame + 1).join(', ')}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
      {!!audit.sampledAtSeconds?.length && (
        <p className="creator-fineprint">
          Visual samples at{' '}
          {audit.sampledAtSeconds.map((second) => `${second.toFixed(2)}s`).join(', ')}. Sampled
          review can miss issues between frames.
        </p>
      )}
      {revision && (
        <div className="creator-revision-suggestion">
          <h4>A suggested next direction</h4>
          <p>{revision.reason}</p>
          <details>
            <summary>Review proposed prompt changes</summary>
            <dl>
              <dt>Direction</dt>
              <dd>{revision.prompt}</dd>
              <dt>Camera movement</dt>
              <dd>{revision.camera}</dd>
              <dt>Lighting</dt>
              <dd>{revision.lighting}</dd>
            </dl>
          </details>
          <button
            type="button"
            className="creator-secondary-button"
            disabled={!stagedPlan}
            onClick={() => {
              if (!stagedPlan) return;
              c.setPlan(
                (previous) =>
                  stageClipRevision(
                    previous,
                    c.state?.session,
                    c.state?.workflow,
                    job,
                    receipt.clipId,
                    receipt.attempt,
                    blocked,
                  ) ?? previous,
              );
              setStaged(true);
              onStage(receipt.clipId);
            }}
          >
            Use suggested revision
          </button>
          {stagedStillApplied ? (
            <p className="creator-fineprint" role="status">
              Suggestion staged in Shot direction. Review and save it, then review a new quote and
              approve before producing again.
            </p>
          ) : (
            <p className="creator-fineprint">
              Stages direction, camera and lighting for this saved plan. Save other edits first; an
              earlier plan’s suggestions stay read only. No clip is generated by this action.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
