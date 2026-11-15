import type { Workflow } from '@yap/contracts/workflow';

export function AgentRunReceipt({
  receipt,
}: {
  receipt: NonNullable<Workflow['script']>['agentRun'];
}) {
  if (!receipt) return null;
  return (
    <details style={{ overflowWrap: 'anywhere' }}>
      <summary>Deep Agents drafting receipt</summary>
      <p>
        Original generation: {receipt.model} · {receipt.modelCalls} model calls ·{' '}
        {receipt.toolCalls} tool calls. Later edits still need your review.
      </p>
      <p>Specialists: {receipt.specialists.map((name) => name.replaceAll('_', ' ')).join(', ')}.</p>
      <p>{receipt.reviewSummary}</p>
      {receipt.researchNotes && <p>{receipt.researchNotes}</p>}
      <p>
        {receipt.researchEvidenceIds.length} attributed research source
        {receipt.researchEvidenceIds.length === 1 ? '' : 's'} · context{' '}
        {receipt.contextSha256.slice(0, 12)}.
      </p>
    </details>
  );
}
