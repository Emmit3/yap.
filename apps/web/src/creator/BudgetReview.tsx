import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, ArrowsClockwise, WarningCircle } from '@phosphor-icons/react';
import { isActiveJob, outputIsCurrent, planCurrent } from './model';
import { formatUsd, quoteIsAffordable, quoteIsCurrent } from './quote';
import type { CreatorController } from './useCreatorSession';

export function BudgetReview({ c, onOpenPromo }: { c: CreatorController; onOpenPromo(): void }) {
  const state = c.state!;
  const plan = state.session.plan!;
  const quote = c.quote;
  const budget = c.budget;
  const [reviewed, setReviewed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = isActiveJob(c.job);
  const activeProduction = active && c.job?.kind === 'production';
  const completed = outputIsCurrent(c.job, state.session, state.workflow);
  const savedRun = activeProduction || completed;
  const failed = c.job?.kind === 'production' && ['failed', 'canceled'].includes(c.job.status);
  const currentPlan = planCurrent(state.session, state.workflow);
  const currentQuote = quoteIsCurrent(quote, state.session, state.workflow, now);
  const affordable = quoteIsAffordable(quote, budget);
  const expired = Boolean(quote && Date.parse(quote.expiresAt) <= now);
  const consumed = Boolean(quote?.consumedByJobId);
  const available = c.capabilities?.configured && c.capabilities.visionConfigured;
  const provider = plan.provider ?? (plan.model === 'seedance-v1.5-pro' ? 'fal' : 'runway');
  const model = plan.model;
  const overrides = plan.clips.some((clip) => clip.videoProfileId);
  const modelLabel = overrides
    ? 'Profiles selected per shot'
    : model === 'seedance-v1.5-pro'
      ? 'Seedance 1.5 Pro (retired)'
      : model === 'gen4_turbo'
        ? 'Gen 4 Turbo'
        : 'Gen 4.5';
  const minimumSeconds = provider === 'fal' || model === 'seedance-v1.5-pro' ? 4 : 2;
  const invalidDuration = plan.clips.some((clip) => {
    const profile = c.capabilities?.videoProfiles?.find((item) => item.id === clip.videoProfileId);
    return (
      !Number.isInteger(clip.seconds) ||
      clip.seconds < (profile?.minSeconds ?? minimumSeconds) ||
      clip.seconds > (profile?.maxSeconds ?? 10) ||
      Boolean(profile?.allowedSeconds && !profile.allowedSeconds.includes(clip.seconds))
    );
  });
  const blocked =
    Boolean(c.busy) || c.dirty || c.needsReload || active || !currentPlan || invalidDuration;
  const canApprove = Boolean(
    quote &&
    currentQuote &&
    affordable &&
    available &&
    !consumed &&
    !c.budgetError &&
    !blocked &&
    !savedRun,
  );
  const reviewKey = quote
    ? `${quote.id}:${quote.fingerprint}:${quote.maxCostCents}:${quote.expiresAt}`
    : '';
  const blockedReason = c.busy
    ? c.busy
    : c.needsReload
      ? 'Reload the saved studio using the recovery control above.'
      : c.dirty
        ? 'Save or discard local changes before requesting a quote.'
        : active
          ? 'Wait for the current research job to finish, or cancel it in job activity.'
          : !currentPlan
            ? 'Prepare the current film version before requesting a quote.'
            : invalidDuration
              ? `Save clip durations from ${minimumSeconds} to 10 seconds for this model.`
              : '';

  useEffect(() => {
    setNow(Date.now());
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote?.id, quote?.expiresAt]);
  useEffect(() => setReviewed(false), [reviewKey, c.dirty, currentQuote, expired]);

  const remaining = quote ? Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000)) : 0;
  const expiryLabel = quote
    ? new Date(quote.expiresAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';
  const requestLabel = failed
    ? 'Get new quote for remaining clips'
    : quote
      ? 'Request a new quote'
      : 'Request quote';

  return (
    <section
      className="creator-production-review creator-budget-review"
      aria-labelledby="creator-approval-title"
      aria-busy={Boolean(c.busy)}
    >
      <div className="creator-section-title">
        <div>
          <span className="creator-kicker">Before production</span>
          <h2 id="creator-approval-title">Review the film. Then the cost.</h2>
          <p>
            Request a quote for the saved shots, review its ceiling, and approve that exact quote
            before paid work starts.
          </p>
        </div>
        <span className="creator-count">
          {plan.clips.length} shots / {plan.clips.reduce((total, clip) => total + clip.seconds, 0)}s
        </span>
      </div>

      <dl className="creator-generation-spec">
        <div>
          <dt>Provider</dt>
          <dd>
            {overrides
              ? 'Listed for each shot below'
              : provider === 'fal'
                ? 'fal.ai (retired model)'
                : 'Runway'}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{modelLabel}</dd>
        </div>
        <div>
          <dt>Clip format</dt>
          <dd>
            {plan.outputProfileId === 'landscape-720'
              ? '1280 × 720 landscape'
              : plan.outputProfileId === 'portrait-720'
                ? '720 × 1280 portrait'
                : '1080 × 1920 portrait, resized'}{' '}
            / silent source clips
          </dd>
        </div>
        <div>
          <dt>Sound</dt>
          <dd>
            {plan.audio?.voice ? `Narration (${plan.audio.voice})` : 'No narration'} /{' '}
            {c.capabilities?.musicTracks.find((track) => track.id === plan.audio?.musicTrackId)
              ?.title ?? 'no music'}
          </dd>
        </div>
        <div>
          <dt>Subtitles</dt>
          <dd>{plan.subtitlesEnabled === true ? 'Burned in / included' : 'Off'}</dd>
        </div>
        <div>
          <dt>Clip duration</dt>
          <dd>{minimumSeconds}–10s per shot</dd>
        </div>
      </dl>

      <div className="creator-budget-ledger">
        <div className="creator-small-heading">
          <h3>Shared project budget</h3>
          <span>USD / server snapshot</span>
        </div>
        {budget ? (
          <dl>
            <div>
              <dt>Project limit</dt>
              <dd>{formatUsd(budget.limitCents)}</dd>
            </div>
            <div>
              <dt>Charged</dt>
              <dd>{formatUsd(budget.chargedCents)}</dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd>{formatUsd(budget.reservedCents)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{formatUsd(budget.availableCents)}</dd>
            </div>
          </dl>
        ) : (
          <p className="creator-fineprint">
            {savedRun
              ? 'The budget snapshot is unavailable. The saved run remains available in job activity.'
              : 'Request a quote to load the server budget. Paid generation stays unavailable until a budget is known.'}
          </p>
        )}
        <p className="creator-fineprint">
          This limit is shared across saved films. Availability is checked again before paid work.
          Canceling work does not automatically release an uncertain provider charge.
        </p>
      </div>
      {c.budgetError && (
        <div className="creator-inline-error" role="alert">
          <p>{c.budgetError}</p>
          <p>Request a fresh quote to check the current budget.</p>
        </div>
      )}

      {quote && (
        <div className="creator-quote-receipt">
          <div className="creator-quote-total">
            <div>
              <span className="creator-kicker">Conservative quote ceiling / USD</span>
              <strong>{formatUsd(quote.maxCostCents)}</strong>
              <p>
                For the next listed attempts and their visual reviews
                {quote.audioCents > 0 ? ', plus narration' : ''}.
              </p>
            </div>
            <div className="creator-quote-expiry">
              <span>
                {consumed ? 'Used by a saved run' : expired ? 'Quote expired' : 'Quote expires'}
              </span>
              <time dateTime={quote.expiresAt}>{expiryLabel}</time>
              {!consumed && !expired && (
                <small aria-hidden="true">
                  {Math.floor(remaining / 60)}m {String(remaining % 60).padStart(2, '0')}s remaining
                </small>
              )}
            </div>
          </div>
          <div
            className="creator-quote-table-wrap"
            role="region"
            aria-label="Quoted clip costs"
            tabIndex={0}
          >
            <table className="creator-quote-table">
              <caption>
                Server quote for the saved shots. Reused clips retain their prior audit.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Shot</th>
                  <th scope="col">Work</th>
                  <th scope="col">Video</th>
                  <th scope="col">Visual review</th>
                  <th scope="col">Ceiling</th>
                </tr>
              </thead>
              <tbody>
                {quote.clips.map((clip) => {
                  const index = plan.clips.findIndex((item) => item.id === clip.clipId);
                  return (
                    <tr key={clip.clipId}>
                      <th scope="row">
                        Shot {index >= 0 ? index + 1 : 'from earlier plan'}
                        <small>{clip.seconds}s</small>
                        {clip.videoProfileId && (
                          <small>
                            {c.capabilities?.videoProfiles?.find(
                              (profile) => profile.id === clip.videoProfileId,
                            )?.label ?? clip.videoProfileId}{' '}
                            / {clip.nativeWidth} × {clip.nativeHeight}
                          </small>
                        )}
                      </th>
                      <td>
                        {clip.reuse
                          ? 'Reuse audited clip'
                          : `Attempt ${clip.attempt} of ${plan.maxAttemptsPerClip}`}
                      </td>
                      <td>{formatUsd(clip.videoCents)}</td>
                      <td>{formatUsd(clip.visionCents)}</td>
                      <td>{formatUsd(clip.costCents)}</td>
                    </tr>
                  );
                })}
                {quote.hasAudio && (
                  <tr>
                    <th scope="row">
                      Sound
                      <small>whole film</small>
                    </th>
                    <td>
                      {quote.narratedSegments > 0
                        ? `Narration, ${quote.narratedSegments} ${quote.narratedSegments === 1 ? 'line' : 'lines'}`
                        : 'Music only'}
                      {quote.audio?.musicTrackId && quote.narratedSegments > 0 ? ' + music' : ''}
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td>{formatUsd(quote.audioCents)}</td>
                  </tr>
                )}
                {quote.subtitlesEnabled === true && (
                  <tr>
                    <th scope="row">Subtitles</th>
                    <td>Burned in + SRT download</td>
                    <td>—</td>
                    <td>—</td>
                    <td>Included</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="creator-fineprint">
            Only the attempts listed in this quote are approved. A failed audit never starts a paid
            retry automatically. Remaining attempts need a fresh quote and your approval.
          </p>
        </div>
      )}

      {!currentPlan && (
        <div className="creator-inline-error">
          <p>
            The saved shot plan is out of date. Prepare the current version before requesting a
            quote.
          </p>
          <button
            className="creator-text-button"
            disabled={Boolean(c.busy) || c.dirty || c.needsReload || active}
            onClick={c.prepare}
          >
            Prepare the current version
          </button>
        </div>
      )}
      {invalidDuration && (
        <div className="creator-inline-error">
          <p>
            {modelLabel} requires clips from {minimumSeconds} to 10 seconds. Update the shot
            durations and save before requesting a quote.
          </p>
        </div>
      )}
      {c.dirty && (
        <p className="creator-fineprint">
          Save your changes before requesting or approving a quote.
        </p>
      )}
      {c.needsReload && (
        <p className="creator-fineprint">
          Reload the saved studio before requesting or approving a quote.
        </p>
      )}
      {!savedRun && quote && !consumed && expired && (
        <p className="creator-inline-error" role="status">
          This quote has expired. Request a fresh quote before approving any paid work.
        </p>
      )}
      {!savedRun && quote && !consumed && !expired && !currentQuote && (
        <p className="creator-inline-error" role="status">
          This quote no longer matches the saved film or production policy. Request a fresh quote
          after saving your changes.
        </p>
      )}
      {!savedRun && quote && !consumed && budget && !affordable && (
        <p className="creator-inline-error" role="status">
          The quoted ceiling exceeds the available project budget. Reduce the plan or wait for
          reserved work to settle, then request a fresh quote.
        </p>
      )}
      {!available && (
        <div className="creator-provider-note">
          <WarningCircle size={20} />
          <p>
            {!c.capabilities && !c.capabilityError
              ? 'Checking generation and visual review availability. Quote review is available while the connection is checked.'
              : c.capabilities?.reason ||
                c.capabilityError ||
                'Generation and visual review providers are not configured. You can keep refining the film or continue with the photo editor.'}
          </p>
        </div>
      )}

      {savedRun ? (
        <div className="creator-review-actions">
          <button
            className="creator-primary-button"
            disabled={Boolean(c.busy)}
            onClick={c.reconnect}
          >
            {activeProduction ? 'Reconnect to generation' : 'View saved generation'}{' '}
            <ArrowsClockwise size={18} />
          </button>
          <p className="creator-fineprint">
            This opens the existing run. It does not request a new quote or start another paid
            attempt.
          </p>
        </div>
      ) : (
        <>
          <div className="creator-review-actions">
            <button
              className="creator-secondary-button"
              disabled={blocked}
              aria-describedby={blockedReason ? 'creator-quote-blocked-reason' : undefined}
              onClick={c.requestQuote}
            >
              {requestLabel} <ArrowsClockwise size={17} />
            </button>
            <span className="creator-fineprint">Requesting a quote does not generate footage.</span>
          </div>
          {blockedReason && (
            <p className="creator-fineprint" id="creator-quote-blocked-reason" role="status">
              {blockedReason}
            </p>
          )}
          {quote && !consumed && (
            <>
              <label className="creator-review-checkbox">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={!canApprove}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <span>
                  I reviewed the script, source choices and every shot. I approve this quote for up
                  to <strong>{formatUsd(quote.maxCostCents)} USD</strong> for the listed attempts
                  and required visual reviews.
                </span>
              </label>
              <div className="creator-review-actions">
                <button
                  className="creator-primary-button"
                  disabled={!canApprove || !reviewed}
                  onClick={() => c.approveAndProduce(reviewed)}
                >
                  Approve quote and generate <ArrowUpRight size={18} />
                </button>
              </div>
            </>
          )}
          {consumed && (
            <p className="creator-fineprint">
              This quote has already been used. Review the saved job activity; any remaining clips
              require a new quote and explicit cost approval.
            </p>
          )}
        </>
      )}
      <button
        className="creator-text-button creator-budget-alternative"
        disabled={Boolean(c.busy) || active || c.dirty}
        onClick={onOpenPromo}
      >
        Use my photos for a silent promo instead <ArrowRight size={16} />
      </button>
    </section>
  );
}
