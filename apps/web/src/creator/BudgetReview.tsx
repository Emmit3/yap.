import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, ArrowsClockwise, WarningCircle } from '@phosphor-icons/react';
import { isActiveJob, outputIsCurrent, planCurrent } from './model';
import { formatUsd, quoteIsAffordable, quoteIsCurrent } from './quote';
import type { CreatorController } from './useCreatorSession';

export function BudgetReview({
  c,
  onOpenPromo,
  onChooseFrames,
}: {
  c: CreatorController;
  onOpenPromo(): void;
  onChooseFrames?(): void;
}) {
  const state = c.state!;
  const plan = state.session.plan!;
  const quote = c.quote;
  const budget = c.budget;
  const [reviewed, setReviewed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = isActiveJob(c.job) || c.imageWorkActive;
  const activeProduction = isActiveJob(c.job) && c.job?.kind === 'production';
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
  const modelLabel =
    model === 'minimax-h3-max'
      ? 'MiniMax H3 Max'
      : model === 'seedance-v1.5-pro'
        ? 'Seedance 1.5 Pro'
        : 'Gen 4.5';
  const minimumSeconds =
    model === 'minimax-h3-max' ? 2 : provider === 'fal' || model === 'seedance-v1.5-pro' ? 4 : 2;
  const maximumSeconds = 10;
  const missingFrames =
    model === 'minimax-h3-max' && plan.clips.some((clip) => !clip.assetId && !clip.keyframeId);
  const invalidDuration = plan.clips.some(
    (clip) =>
      !Number.isInteger(clip.seconds) ||
      clip.seconds < minimumSeconds ||
      clip.seconds > maximumSeconds,
  );
  const blocked =
    Boolean(c.busy) ||
    c.dirty ||
    c.needsReload ||
    active ||
    !currentPlan ||
    invalidDuration ||
    missingFrames ||
    Boolean(budget?.pausedReason);
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
          ? 'Finish or cancel the current job first.'
          : !currentPlan
            ? 'Prepare the current film version before requesting a quote.'
            : invalidDuration
              ? `Save clip durations from ${minimumSeconds} to ${maximumSeconds} seconds for this model.`
              : missingFrames
                ? 'Choose a starting image for every shot.'
                : '';
  const quoteProblem =
    !savedRun && quote && !consumed
      ? expired
        ? 'This quote expired. Request a fresh quote.'
        : !currentQuote
          ? 'This quote no longer matches the saved film. Review a new cost.'
          : budget && !affordable
            ? 'This quote exceeds the available budget. Reduce the plan or wait for reserved work to settle.'
            : ''
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
          <h2 id="creator-approval-title">Make video</h2>
          <p>
            {plan.clips.length} shots ·{' '}
            {plan.clips.reduce((total, clip) => total + clip.seconds, 0)}s{' · '}
            {modelLabel}
          </p>
        </div>
      </div>

      <details className="creator-generation-disclosure">
        <summary>Video settings and budget</summary>
        <dl className="creator-generation-spec">
          <div>
            <dt>Provider</dt>
            <dd>{provider === 'fal' ? 'fal.ai' : 'Runway'}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{modelLabel}</dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>9:16 · silent export</dd>
          </div>
          <div>
            <dt>Clip duration</dt>
            <dd>
              {minimumSeconds}–{maximumSeconds}s per shot
            </dd>
          </div>
        </dl>

        <div className="creator-budget-ledger">
          <div className="creator-small-heading">
            <h3>Shared budget</h3>
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
      </details>
      {budget?.pausedReason && (
        <p className="creator-inline-error" role="alert">
          Paid generation is paused: {budget.pausedReason}
        </p>
      )}
      {c.budgetError && (
        <div className="creator-inline-error" role="alert">
          <p>{c.budgetError}</p>
        </div>
      )}

      {quote && (
        <div className="creator-quote-receipt">
          <div className="creator-quote-total">
            <div>
              <span>Maximum for this quote</span>
              <strong>{formatUsd(quote.maxCostCents)}</strong>
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
          <details>
            <summary>Cost breakdown</summary>
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
                </tbody>
              </table>
            </div>
          </details>
          <p className="creator-fineprint">
            Includes the listed attempts and visual reviews. Paid retries need a new quote and
            approval.
          </p>
        </div>
      )}

      {!blockedReason && quoteProblem && (
        <p className="creator-inline-error" role="status">
          {quoteProblem}
        </p>
      )}
      {!available && !savedRun && (
        <div className="creator-provider-note">
          <WarningCircle size={20} />
          <details>
            <summary>
              {!c.capabilities && !c.capabilityError
                ? 'Checking video connection'
                : 'Video connection needed'}
            </summary>
            <p>
              {!c.capabilities && !c.capabilityError
                ? 'Checking generation and visual review availability. Quote review is available while the connection is checked.'
                : c.capabilities?.reason ||
                  c.capabilityError ||
                  'Generation and visual review providers are not configured. You can keep refining the film or continue with the photo editor.'}
            </p>
          </details>
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
          <p className="creator-fineprint">Opens the saved run without starting new work.</p>
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
            <div className="creator-fineprint" id="creator-quote-blocked-reason" role="status">
              {blockedReason}
              {missingFrames &&
                currentPlan &&
                !invalidDuration &&
                !c.busy &&
                !c.dirty &&
                !c.needsReload &&
                !active && (
                  <button
                    className="creator-text-button"
                    onClick={() => {
                      if (onChooseFrames) {
                        onChooseFrames();
                        return;
                      }
                      document
                        .getElementById('creator-visual-studio')
                        ?.scrollIntoView({ behavior: 'auto', block: 'start' });
                      document.getElementById('keyframe-studio-title')?.focus();
                    }}
                  >
                    Choose starting images <ArrowUpRight size={16} />
                  </button>
                )}
              {!currentPlan && !c.busy && !c.dirty && !c.needsReload && !active && (
                <button className="creator-text-button" onClick={c.prepare}>
                  Prepare the current version
                </button>
              )}
            </div>
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
                  I reviewed the script, sources and shots, and approve up to{' '}
                  <strong>{formatUsd(quote.maxCostCents)} USD</strong> for this quote.
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
      <details>
        <summary>Other options</summary>
        <button
          className="creator-text-button creator-budget-alternative"
          disabled={Boolean(c.busy) || active || c.dirty}
          onClick={onOpenPromo}
        >
          Use my photos for a silent promo instead <ArrowRight size={16} />
        </button>
      </details>
    </section>
  );
}
