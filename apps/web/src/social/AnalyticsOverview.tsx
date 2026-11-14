import React from 'react';
import { ArrowRight, ArrowUpRight, WarningCircle } from '@phosphor-icons/react';
import type { SocialInvestigation, SocialPlatform, SocialPost } from '@yap/contracts/social';
import { analyticsOverview } from './analytics-overview';

const providers: Record<SocialPost['provider'], string> = {
  demo: 'Synthetic example',
  firecrawl: 'Firecrawl',
  x: 'X API',
  xai: 'Grok citations',
  instagram: 'Instagram',
  import: 'Public import',
};
const platforms: Record<SocialPlatform, string> = {
  x: 'X',
  instagram: 'Instagram',
  web: 'Public web',
};
const timestamp = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function DateSpan({ range }: { range: { first: string; last: string } | null }) {
  if (!range) return <span>Not returned by the sources</span>;
  return (
    <>
      <time dateTime={range.first}>{timestamp(range.first)}</time>
      {range.last !== range.first && (
        <>
          {' '}
          to <time dateTime={range.last}>{timestamp(range.last)}</time>
        </>
      )}
    </>
  );
}

export default function AnalyticsOverview({
  investigation,
  selectedInsightIds,
  disabled,
  onToggleInsight,
  onEvidence,
  onReviewFindings,
}: {
  investigation: SocialInvestigation;
  selectedInsightIds: string[];
  disabled: boolean;
  onToggleInsight: (id: string) => void;
  onEvidence: (id: string) => void;
  onReviewFindings: () => void;
}) {
  const data = analyticsOverview(investigation);
  const { analysis } = investigation;
  return (
    <section className="social-analytics-overview" aria-labelledby="social-overview-title">
      <div className="social-overview-heading">
        <div>
          <h3 id="social-overview-title">What this research suggests</h3>
          <p>{analysis.summary}</p>
        </div>
        <span className={data.illustrative ? 'social-demo-badge' : 'social-provenance-label'}>
          {data.illustrative ? 'Illustrative evidence' : 'Saved public evidence'}
        </span>
      </div>
      <dl className="social-evidence-totals">
        <div>
          <dt>Evidence items</dt>
          <dd>{analysis.posts.length}</dd>
        </div>
        <div>
          <dt>Observed links</dt>
          <dd>{analysis.coverage.observedRelationshipCount}</dd>
        </div>
        <div>
          <dt>Derived wording links</dt>
          <dd>{analysis.coverage.inferredRelationshipCount}</dd>
        </div>
        <div>
          <dt>Items with metrics</dt>
          <dd>
            {data.withMetrics} <span>of {analysis.posts.length}</span>
          </dd>
        </div>
      </dl>
      {!analysis.coverage.observedRelationshipCount && (
        <p className="social-network-gap">
          <WarningCircle size={16} />
          No observed public interactions were returned. Content similarities do not establish
          communication or amplification.
        </p>
      )}
      {data.illustrative && (
        <p className="social-network-gap">
          <WarningCircle size={16} />
          This example contains synthetic posts, accounts, dates, and metrics. It is not a live
          finding.
        </p>
      )}
      {data.featured && (
        <article className="social-featured-finding">
          <div className="social-featured-title">
            <div>
              <span className="social-caption">
                Interpretation to review · {data.featured.confidence} confidence within this sample
              </span>
              <h4>{data.featured.title}</h4>
            </div>
            <label className="social-select-decision">
              <input
                type="checkbox"
                checked={selectedInsightIds.includes(data.featured.id)}
                disabled={disabled}
                onChange={() => onToggleInsight(data.featured!.id)}
              />
              Include this finding
            </label>
          </div>
          <div className="social-overview-tradeoffs">
            <div>
              <strong>Potential strength</strong>
              <p>
                {data.featured.pros[0] ??
                  'Inspect the source context before adopting this pattern.'}
              </p>
            </div>
            <div>
              <strong>Tradeoff</strong>
              <p>{data.featured.cons[0] ?? 'This sample cannot establish why a post performed.'}</p>
            </div>
          </div>
          <div className="social-featured-actions">
            <div className="social-evidence-links">
              {data.evidence.map((post, index) => (
                <button type="button" key={post.id} onClick={() => onEvidence(post.id)}>
                  Inspect source {index + 1}
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </div>
            <button type="button" className="social-text-button" onClick={onReviewFindings}>
              Review all findings
              <ArrowRight size={16} />
            </button>
          </div>
        </article>
      )}
      <details className="social-overview-provenance">
        <summary>
          Source coverage and provenance{' '}
          <span>
            {data.withDates} of {analysis.posts.length} publication dates known
          </span>
        </summary>
        <dl className="social-provenance-grid">
          <div>
            <dt>Returned source coverage</dt>
            <dd>
              {data.platforms.map((item) => (
                <span key={item.platform}>
                  {platforms[item.platform]}: {item.count} returned
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>Collection providers</dt>
            <dd>
              {data.providers.length
                ? data.providers.map((item) => (
                    <span key={item.provider}>
                      {providers[item.provider]}: {item.count}
                    </span>
                  ))
                : 'No source records returned'}
            </dd>
          </div>
          <div>
            <dt>Material retrieved</dt>
            <dd>
              {data.completePosts} post records · {data.searchExcerpts} search excerpts ·{' '}
              {data.pages} pages
            </dd>
          </div>
          <div>
            <dt>Collection window</dt>
            <dd>
              <DateSpan range={data.collection} />
            </dd>
          </div>
          <div>
            <dt>Reported publication window</dt>
            <dd>
              <DateSpan range={data.publication} />
            </dd>
          </div>
          <div>
            <dt>Analysis scope</dt>
            <dd>
              {analysis.actors.length} public actors · {analysis.communities.length} estimated
              groups.{' '}
              {analysis.coverage.partial
                ? 'Partial sample; platform coverage is incomplete.'
                : 'Only the returned source records are represented.'}{' '}
              Similarity and estimated communities are derived interpretations.
            </dd>
          </div>
        </dl>
        {!!analysis.coverage.warnings.length && (
          <ul className="social-provenance-cautions">
            {analysis.coverage.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
