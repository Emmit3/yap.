import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  DownloadSimple,
  Image,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import {
  workflowBriefSchema,
  updateWorkflowScriptSchema,
  updateWorkflowScenesSchema,
  type Workflow,
  type WorkflowBrief,
  type WorkflowQuestionField,
  type WorkflowScene,
} from '@yap/contracts/workflow';
import type { RenderJob } from '@yap/contracts/render';
import type { SocialHandoff } from '@yap/contracts/social';
import { ErrorNotice, LoadingState, PageHeading, platformNames, toneNames } from '../components';
import {
  promoApi,
  PromoApiError,
  isPromoAbort,
  promoMessage,
  type PublishKit,
  type WorkflowResponse,
} from './api';
import './promo.css';

export interface PromoWorkspaceProps {
  id?: string;
  onBack(): void;
  onCreated(id: string): void;
  onDirty(value: boolean): void;
  initialInput?: string;
  research?: SocialHandoff;
}

type BriefForm = {
  productName: string;
  productDescription: string;
  audience: string;
  keyBenefits: string;
  callToAction: string;
  imageDirection: string;
  platform: 'instagram' | 'tiktok' | 'youtube';
  tone: 'conversational' | 'educational' | 'bold';
  duration: 15 | 30 | 60;
};
type ScriptForm = {
  hook: string;
  segments: NonNullable<Workflow['script']>['segments'];
  caption: string;
};
type Drafts = {
  brief: BriefForm;
  script: ScriptForm | null;
  scenes: WorkflowScene[] | null;
  descriptions: Record<string, string>;
};
type Scope = 'brief' | 'script' | 'scenes' | 'descriptions' | 'refinement';
type Flags = Record<Scope, boolean>;
type PendingPhoto = { key: string; file: File; description: string; preview: string };
type Conflict = {
  latest: WorkflowResponse | null;
  base: Workflow;
  local: Drafts;
  flags: Flags;
  answers: Partial<Record<WorkflowQuestionField, string>>;
  refinement: string;
};

const blankBrief = (): BriefForm => ({
  productName: '',
  productDescription: '',
  audience: '',
  keyBenefits: '',
  callToAction: '',
  imageDirection: '',
  platform: 'instagram',
  tone: 'conversational',
  duration: 15,
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const activeJob = (job: RenderJob | null) => job?.status === 'queued' || job?.status === 'running';
const fields: Array<{
  key: keyof Pick<
    BriefForm,
    | 'productName'
    | 'productDescription'
    | 'audience'
    | 'keyBenefits'
    | 'callToAction'
    | 'imageDirection'
  >;
  label: string;
  help: string;
  max: number;
  large?: boolean;
}> = [
  {
    key: 'productName',
    label: 'Business or product name',
    help: 'The name people should remember.',
    max: 120,
  },
  {
    key: 'productDescription',
    label: 'What do you offer?',
    help: 'Use facts you can stand behind. Include the offer, place or occasion.',
    max: 4000,
    large: true,
  },
  {
    key: 'audience',
    label: 'Who is this for?',
    help: 'Describe the people you want to reach.',
    max: 500,
  },
  {
    key: 'keyBenefits',
    label: 'What should people love about it?',
    help: 'One real benefit per line, up to ten.',
    max: 4000,
    large: true,
  },
  {
    key: 'callToAction',
    label: 'What should they do next?',
    help: 'Visit, order, book or find out more. Include the destination.',
    max: 500,
  },
  {
    key: 'imageDirection',
    label: 'Photo direction',
    help: 'Tell us what to highlight or avoid in your supplied photos.',
    max: 2000,
    large: true,
  },
];

function fromWorkflow(workflow: Workflow): Drafts {
  return {
    brief: {
      ...blankBrief(),
      ...workflow.brief,
      keyBenefits: workflow.brief.keyBenefits?.join('\n') ?? '',
    },
    script: workflow.script
      ? {
          hook: workflow.script.hook,
          caption: workflow.script.caption,
          segments: workflow.script.segments.map((segment) => ({ ...segment })),
        }
      : null,
    scenes:
      workflow.scenes?.scenes.map((scene) => ({ ...scene, assetIds: [...scene.assetIds] })) ?? null,
    descriptions: Object.fromEntries(workflow.assets.map((asset) => [asset.id, asset.description])),
  };
}

function briefInput(form: BriefForm): WorkflowBrief {
  const result: WorkflowBrief = {
    platform: form.platform,
    tone: form.tone,
    duration: form.duration,
  };
  for (const field of fields) {
    const value = form[field.key].trim();
    if (!value) continue;
    if (field.key === 'keyBenefits')
      result.keyBenefits = value
        .split(/\n|;/)
        .map((item) => item.trim())
        .filter(Boolean);
    else result[field.key] = value;
  }
  const parsed = workflowBriefSchema.safeParse(result);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' '),
    );
  return parsed.data;
}

function changedScopes(
  saved: WorkflowResponse | null,
  local: Drafts,
  answers: Partial<Record<WorkflowQuestionField, string>>,
  refinement: string,
): Flags {
  const baseline = saved ? fromWorkflow(saved.workflow) : null;
  return {
    brief: Boolean(baseline && !equal(local.brief, baseline.brief)),
    script: Boolean(baseline && !equal(local.script, baseline.script)),
    scenes: Boolean(baseline && !equal(local.scenes, baseline.scenes)),
    descriptions: Boolean(baseline && !equal(local.descriptions, baseline.descriptions)),
    refinement: Boolean(
      refinement.trim() || Object.values(answers).some((answer) => answer?.trim()),
    ),
  };
}

export function PromoWorkspace({
  id,
  onBack,
  onCreated,
  onDirty,
  initialInput = '',
  research,
}: PromoWorkspaceProps) {
  const [envelope, setEnvelope] = useState<WorkflowResponse | null>(null);
  const [draft, setDraftState] = useState<Drafts>({
    brief: blankBrief(),
    script: null,
    scenes: null,
    descriptions: {},
  });
  const [input, setInput] = useState(initialInput);
  const [title, setTitle] = useState('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [answers, setAnswers] = useState<Partial<Record<WorkflowQuestionField, string>>>({});
  const [refinement, setRefinement] = useState('');
  const [loading, setLoading] = useState(Boolean(id));
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [polling, setPolling] = useState(false);
  const [kit, setKit] = useState<PublishKit | null>(null);
  const [uncertainCreation, setUncertainCreation] = useState(false);
  const operation = useRef(false);
  const mounted = useRef(true);
  const current = useRef<WorkflowResponse | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const photoRef = useRef(photos);
  const notifyCreated = useRef(false);
  const operationEpoch = useRef(0);
  const localDraft = useRef(draft);
  const localAnswers = useRef(answers);
  const localRefinement = useRef(refinement);
  const callback = useRef({ onCreated, onDirty });
  callback.current = { onCreated, onDirty };
  photoRef.current = photos;
  localDraft.current = draft;
  localAnswers.current = answers;
  localRefinement.current = refinement;

  function setDraft(next: Drafts | ((previous: Drafts) => Drafts)) {
    const value = typeof next === 'function' ? next(localDraft.current) : next;
    localDraft.current = value;
    setDraftState(value);
  }

  const baseline = useMemo(() => (envelope ? fromWorkflow(envelope.workflow) : null), [envelope]);
  const flags = changedScopes(envelope, draft, answers, refinement);
  const hasEdits = Object.values(flags).some(Boolean) || photos.length > 0;
  const dirty = envelope
    ? hasEdits
    : Boolean(input.trim() || title.trim() || photos.length || !equal(draft.brief, blankBrief()));
  const rendering = activeJob(job);
  const locked = Boolean(busy || conflict || rendering || polling);
  const canEdit = (scope: Scope) =>
    !locked &&
    !Object.entries(flags).some(([key, changed]) => key !== scope && changed) &&
    (!photos.length || scope === 'descriptions');
  const workflow = envelope?.workflow;
  const researchContext = workflow?.research ?? (!workflow ? research : undefined);
  const reports = envelope ? Object.values(envelope.verification) : [];
  const blocked = reports.some((report) => report.state === 'blocked');
  const canReview = Boolean(
    workflow?.script &&
    workflow.scenes &&
    workflow.assets.length &&
    !blocked &&
    !hasEdits &&
    !locked,
  );
  const currentOutput = Boolean(
    kit &&
    workflow &&
    kit.workflowId === workflow.id &&
    kit.workflowVersion === workflow.version &&
    !hasEdits,
  );
  const incompatibleConflict = Boolean(
    conflict?.latest &&
    ((conflict.flags.script && conflict.base.script?.id !== conflict.latest.workflow.script?.id) ||
      (conflict.flags.scenes &&
        (conflict.base.scenes?.id !== conflict.latest.workflow.scenes?.id ||
          conflict.base.script?.id !== conflict.latest.workflow.script?.id)) ||
      (conflict.flags.descriptions &&
        conflict.base.assets.some(
          (asset) =>
            conflict.local.descriptions[asset.id] !== asset.description &&
            !conflict.latest!.workflow.assets.some((latest) => latest.id === asset.id),
        ))),
  );

  useEffect(() => {
    callback.current.onDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestController.current?.abort();
      pollController.current?.abort();
      photoRef.current.forEach((photo) => URL.revokeObjectURL(photo.preview));
      callback.current.onDirty(false);
    };
  }, []);

  function accept(next: WorkflowResponse) {
    current.current = next;
    setEnvelope(next);
    setDraft(fromWorkflow(next.workflow));
    setAnswers({});
    setRefinement('');
    setReviewed(false);
    setKit(null);
    setReplaceConfirm(false);
  }

  async function readHandoff(workflowId: string, signal: AbortSignal, expectedVersion: number) {
    try {
      const handoff = await promoApi.getPublishKit(workflowId, signal);
      if (!signal.aborted && mounted.current && handoff.workflowVersion === expectedVersion)
        setKit(handoff);
    } catch (caught) {
      if (isPromoAbort(caught)) return;
      if (caught instanceof PromoApiError && [404, 409, 422].includes(caught.status)) return;
      throw caught;
    }
  }

  function startPolling(render: RenderJob) {
    pollController.current?.abort();
    const controller = new AbortController();
    pollController.current = controller;
    setPolling(true);
    setError('');
    void promoApi
      .waitForRender(render.workflowId, render.id, {
        signal: controller.signal,
        onUpdate: (update) => {
          if (mounted.current && !controller.signal.aborted) setJob(update);
        },
      })
      .then(async (completed) => {
        if (controller.signal.aborted || !mounted.current) return;
        if (completed.status === 'failed') {
          setError(
            completed.error?.message ??
              'The render failed. Review the proposal, then try another render.',
          );
          return;
        }
        const latest = await promoApi.get(completed.workflowId, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        accept(latest);
        await readHandoff(completed.workflowId, controller.signal, latest.workflow.version);
        if (!controller.signal.aborted)
          setNotice(
            completed.sourceScenesId === latest.workflow.scenes?.id
              ? 'Your video is rendered. Review it, then download the MP4 and caption.'
              : 'This export finished for an earlier proposal. Prepare and review the current version before making a new export.',
          );
      })
      .catch((caught) => {
        if (!isPromoAbort(caught) && mounted.current && !controller.signal.aborted)
          setError(promoMessage(caught));
      })
      .finally(() => {
        if (pollController.current === controller) {
          pollController.current = null;
          if (mounted.current) setPolling(false);
        }
      });
  }

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setBusy('');
    void Promise.all([
      promoApi.get(id, controller.signal),
      promoApi.getRenders(id, controller.signal),
    ])
      .then(async ([next, jobs]) => {
        if (controller.signal.aborted) return;
        accept(next);
        const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const found =
          sorted.find((item) => activeJob(item)) ??
          sorted.find((item) => item.sourceScenesId === next.workflow.scenes?.id) ??
          sorted[0] ??
          null;
        setJob(found);
        if (found && activeJob(found)) startPolling(found);
        else await readHandoff(id, controller.signal, next.workflow.version);
      })
      .catch((caught) => {
        if (!isPromoAbort(caught) && !controller.signal.aborted) setError(promoMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      pollController.current?.abort();
      requestController.current?.abort();
      operationEpoch.current += 1;
      operation.current = false;
    };
  }, [id, reloadKey]);

  async function run(
    label: string,
    work: (signal: AbortSignal) => Promise<void>,
    allowConflict = false,
  ) {
    if (operation.current || (conflict && !allowConflict)) return;
    operation.current = true;
    const epoch = ++operationEpoch.current;
    const controller = new AbortController();
    requestController.current = controller;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await work(controller.signal);
    } catch (caught) {
      if (isPromoAbort(caught) || !mounted.current) return;
      setReviewed(false);
      const uncertain =
        caught instanceof PromoApiError &&
        ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(caught.code);
      if (
        caught instanceof PromoApiError &&
        (caught.code === 'WORKFLOW_VERSION_CONFLICT' || uncertain) &&
        current.current
      ) {
        let latest: WorkflowResponse | null = null;
        try {
          latest = await promoApi.get(current.current.workflow.id, controller.signal);
        } catch {
          /* Local edits remain available even if the reload is offline. */
        }
        if (!controller.signal.aborted) {
          const retained = localDraft.current;
          setConflict({
            latest,
            base: current.current.workflow,
            local: retained,
            flags: changedScopes(
              current.current,
              retained,
              localAnswers.current,
              localRefinement.current,
            ),
            answers: localAnswers.current,
            refinement: localRefinement.current,
          });
          if (uncertain)
            setError(
              'The connection was interrupted and the server may have saved part of this change. Compare the saved state before retrying. Your local edits are preserved.',
            );
        }
      } else {
        if (uncertain && !current.current) setUncertainCreation(true);
        setError(promoMessage(caught));
      }
    } finally {
      if (operationEpoch.current === epoch) {
        operation.current = false;
        if (requestController.current === controller) requestController.current = null;
        if (mounted.current) setBusy('');
      }
    }
  }

  function clearPhotos() {
    photoRef.current.forEach((photo) => URL.revokeObjectURL(photo.preview));
    setPhotos([]);
  }
  function editBrief(key: keyof BriefForm, value: string | number) {
    setReviewed(false);
    setDraft((previous) => ({ ...previous, brief: { ...previous.brief, [key]: value } }));
  }
  function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    const available = 20 - (workflow?.assets.length ?? 0) - photos.length;
    if (files.length > available) {
      setError(`You can attach ${Math.max(0, available)} more photos. A promo supports up to 20.`);
      return;
    }
    const invalid = files.find(
      (file) =>
        !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
        file.size > 10 * 1024 * 1024 ||
        file.size === 0,
    );
    if (invalid) {
      setError(`${invalid.name}: choose a JPEG, PNG or WebP image under 10 MiB.`);
      return;
    }
    setReviewed(false);
    setError('');
    setPhotos((previous) => [
      ...previous,
      ...files.map((file) => ({
        key: crypto.randomUUID(),
        file,
        description: '',
        preview: URL.createObjectURL(file),
      })),
    ]);
  }

  async function uploadQueued(state: WorkflowResponse, signal: AbortSignal) {
    let latest = state;
    for (const [index, photo] of photos.entries()) {
      setBusy(`Uploading photo ${index + 1} of ${photos.length}`);
      if (!crypto.subtle)
        throw new Error(
          'Photo uploads need a secure connection. Open this workspace on HTTPS or localhost.',
        );
      const digest = await crypto.subtle.digest('SHA-256', await photo.file.arrayBuffer());
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      signal.throwIfAborted();
      let added = latest.workflow.assets.find((asset) => asset.sha256 === hash);
      if (!added) {
        const uploaded = await promoApi.upload(
          latest.workflow.id,
          latest.workflow.version,
          photo.file,
          signal,
        );
        added = uploaded.workflow.assets.find(
          (asset) => !latest.workflow.assets.some((old) => old.id === asset.id),
        );
        latest = uploaded;
        accept(latest);
      } else setBusy(`Photo ${index + 1} is already saved; using that copy`);
      URL.revokeObjectURL(photo.preview);
      setPhotos((previous) => previous.filter((item) => item.key !== photo.key));
      if (added && photo.description.trim() && added.description !== photo.description.trim()) {
        const assetId = added.id;
        setDraft((previous) => ({
          ...previous,
          descriptions: { ...previous.descriptions, [assetId]: photo.description.trim() },
        }));
        latest = await promoApi.describeAsset(
          latest.workflow.id,
          assetId,
          latest.workflow.version,
          photo.description.trim(),
          signal,
        );
        accept(latest);
      }
    }
    return latest;
  }

  function prepare(regenerate = false) {
    const saved = current.current;
    if (!saved || hasEdits || rendering) return;
    void run(regenerate ? 'Replacing the proposal' : 'Preparing your proposal', async (signal) => {
      const next = await promoApi.prepare(
        saved.workflow.id,
        { expectedVersion: saved.workflow.version, regenerate },
        signal,
      );
      accept(next);
      setNotice('Your proposal is ready to review. Nothing has been approved or rendered.');
      if (notifyCreated.current) {
        notifyCreated.current = false;
        callback.current.onCreated(next.workflow.id);
      }
    });
  }

  function save(scope: Scope) {
    const saved = current.current;
    if (!saved) return;
    void run('Saving your changes', async (signal) => {
      let next = saved;
      if (scope === 'brief') {
        for (const field of fields) {
          if (baseline?.brief[field.key].trim() && !draft.brief[field.key].trim())
            throw new Error(`Keep a value for “${field.label}”, or replace it with updated facts.`);
        }
        next = await promoApi.refine(
          saved.workflow.id,
          { expectedVersion: saved.workflow.version, brief: briefInput(draft.brief) },
          signal,
        );
      } else if (scope === 'script' && draft.script) {
        const payload = updateWorkflowScriptSchema.safeParse({
          expectedVersion: saved.workflow.version,
          ...draft.script,
        });
        if (!payload.success)
          throw new Error(
            'Each copy segment needs text and a whole number of seconds. Keep the hook under 1,000 characters.',
          );
        next = await promoApi.updateScript(saved.workflow.id, payload.data, signal);
      } else if (scope === 'scenes' && draft.scenes) {
        const payload = updateWorkflowScenesSchema.safeParse({
          expectedVersion: saved.workflow.version,
          scenes: draft.scenes,
        });
        if (!payload.success)
          throw new Error(
            'Each scene needs a visual direction, valid timing and its script segment.',
          );
        next = await promoApi.updateScenes(saved.workflow.id, payload.data, signal);
      } else if (scope === 'descriptions') {
        for (const asset of saved.workflow.assets) {
          const description = draft.descriptions[asset.id] ?? '';
          if (description !== asset.description)
            next = await promoApi.describeAsset(
              saved.workflow.id,
              asset.id,
              next.workflow.version,
              description,
              signal,
            );
          current.current = next;
          setEnvelope(next);
          setKit(null);
          setReviewed(false);
        }
      } else if (scope === 'refinement') {
        const values: Partial<Record<WorkflowQuestionField, string>> = {};
        for (const question of saved.workflow.questions) {
          const answer = answers[question.field]?.trim();
          if (answer) values[question.field] = answer;
        }
        next = await promoApi.refine(
          saved.workflow.id,
          {
            expectedVersion: saved.workflow.version,
            ...(refinement.trim() ? { message: refinement.trim() } : {}),
            ...(Object.keys(values).length ? { answers: values } : {}),
          },
          signal,
        );
        accept(next);
        setBusy('Preparing the refined proposal');
        next = await promoApi.prepare(
          next.workflow.id,
          { expectedVersion: next.workflow.version },
          signal,
        );
      }
      accept(next);
      setNotice(
        scope === 'script'
          ? 'Copy saved. Prepare the missing scenes before approving.'
          : scope === 'scenes'
            ? 'Scene plan saved. Review the updated version before approving.'
            : 'Saved. Your previous approvals no longer apply to changed content.',
      );
    });
  }

  function approveAndRender() {
    const saved = current.current;
    if (!saved || !reviewed || !canReview) return;
    void run('Checking for an active render', async (signal) => {
      const jobs = await promoApi.getRenders(saved.workflow.id, signal);
      const pending = jobs.find((item) => activeJob(item));
      if (pending) {
        setJob(pending);
        startPolling(pending);
        setNotice('A render is already processing. Checking that job instead of starting another.');
        return;
      }
      setBusy('Approving the reviewed proposal');
      const approved = await promoApi.approveAll(saved.workflow.id, saved.workflow.version, signal);
      accept(approved);
      setBusy('Starting the render');
      const created = await promoApi.render(
        approved.workflow.id,
        approved.workflow.version,
        signal,
      );
      setJob(created);
      startPolling(created);
    });
  }

  function resolveConflict(keep: boolean) {
    if (!conflict?.latest) return;
    if (keep && incompatibleConflict) return;
    const latest = conflict.latest;
    const merged = fromWorkflow(latest.workflow);
    if (keep) {
      if (conflict.flags.brief) merged.brief = conflict.local.brief;
      if (conflict.flags.script) merged.script = conflict.local.script;
      if (conflict.flags.scenes) merged.scenes = conflict.local.scenes;
      if (conflict.flags.descriptions) {
        for (const asset of latest.workflow.assets) {
          const previous = conflict.base.assets.find((item) => item.id === asset.id);
          if (previous && conflict.local.descriptions[asset.id] !== previous.description)
            merged.descriptions[asset.id] = conflict.local.descriptions[asset.id] ?? '';
        }
      }
    }
    accept(latest);
    setDraft(merged);
    if (keep && conflict.flags.refinement) {
      setAnswers(conflict.answers);
      setRefinement(conflict.refinement);
    }
    setConflict(null);
    setNotice(
      keep
        ? 'Your local edits are preserved against the latest saved version. Compare and save them before reviewing again.'
        : 'Opened the latest saved version. Local form edits were discarded.',
    );
  }

  function discardEdits() {
    if (!workflow) return;
    setDraft(fromWorkflow(workflow));
    setAnswers({});
    setRefinement('');
    setReviewed(false);
    clearPhotos();
    setNotice('Local edits discarded. Showing the saved promo.');
  }

  function downloadCaption() {
    if (!kit) return;
    const url = URL.createObjectURL(new Blob([kit.caption], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'yap-promo-caption.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadLocalEdits() {
    if (!conflict) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              workflowId: conflict.base.id,
              savedVersion: conflict.base.version,
              local: conflict.local,
              answers: conflict.answers,
              refinement: conflict.refinement,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'yap-local-promo-edits.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (loading)
    return (
      <div className="promo">
        <LoadingState label="Opening your saved promo" />
      </div>
    );
  if (id && !envelope)
    return (
      <div className="promo">
        <button className="back-link" onClick={onBack}>
          <ArrowLeft size={16} /> Back to promos
        </button>
        <ErrorNotice
          message={error || 'This promo could not be opened.'}
          onRetry={() => setReloadKey((value) => value + 1)}
        />
      </div>
    );

  return (
    <div className="promo">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Back to promos
      </button>
      <PageHeading
        eyebrow={workflow ? `PHOTO TO PROMO · SAVED VERSION ${workflow.version}` : 'PHOTO TO PROMO'}
        title={workflow?.title ?? 'Your photos. Your next promo.'}
        copy="Start with your business and the photos you already have. Review every word and scene before making a real video."
      >
        {workflow && (
          <span className="promo-saved">
            <Check size={14} /> Saved to your workspace
          </span>
        )}
      </PageHeading>
      <div className="promo-truth">
        <span>1080 × 1920 MP4</span>
        <span>Uses your supplied photos</span>
        <span>Silent video</span>
        <span>You post it yourself</span>
      </div>
      {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
      {notice && (
        <div className="promo-notice" role="status">
          {notice}
        </div>
      )}
      {busy && (
        <div className="promo-busy" role="status">
          <span className="promo-pulse" />
          {busy}…
        </div>
      )}
      {conflict && (
        <section className="promo-conflict" role="alert">
          <WarningCircle size={24} />
          <div>
            <h2>Check the saved version before continuing.</h2>
            <p>
              Your local edits are still here. Compare them with the latest saved version before
              choosing what to keep. Approval was not retried.
            </p>
            {conflict.latest ? (
              <>
                <details>
                  <summary>Compare local and saved content</summary>
                  <div className="promo-comparison">
                    <div>
                      <strong>Your local form</strong>
                      <pre>{JSON.stringify(conflict.local, null, 2)}</pre>
                    </div>
                    <div>
                      <strong>Latest saved version {conflict.latest.workflow.version}</strong>
                      <pre>{JSON.stringify(fromWorkflow(conflict.latest.workflow), null, 2)}</pre>
                    </div>
                  </div>
                </details>
                {incompatibleConflict && (
                  <p>
                    The saved proposal uses different copy, scenes or photos. Download your local
                    edits for reference, then use the saved version to prepare the current proposal.
                    Old artifact edits cannot be applied safely to that new proposal.
                  </p>
                )}
                <div className="promo-actions">
                  <button
                    className="button button-secondary"
                    disabled={incompatibleConflict}
                    onClick={() => resolveConflict(true)}
                  >
                    Keep my edits to compare
                  </button>
                  <button className="text-button" onClick={downloadLocalEdits}>
                    Download my local edits <DownloadSimple size={16} />
                  </button>
                  <button className="text-button" onClick={() => resolveConflict(false)}>
                    Use the saved version
                  </button>
                </div>
              </>
            ) : (
              <button
                className="button button-secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run(
                    'Reloading saved content',
                    async (signal) => {
                      const latest = await promoApi.get(current.current!.workflow.id, signal);
                      setConflict((previous) => (previous ? { ...previous, latest } : null));
                    },
                    true,
                  )
                }
              >
                Reload latest without discarding edits
              </button>
            )}
          </div>
        </section>
      )}
      {hasEdits && workflow && !conflict && (
        <div className="promo-unsaved">
          <span>Local edits · save these before preparing or approving.</span>
          <button className="text-button" disabled={Boolean(busy)} onClick={discardEdits}>
            Discard local edits
          </button>
        </div>
      )}
      {rendering && (
        <div className="promo-notice">
          A render is processing. Editing is paused so this proposal stays clear. Stopping status
          checks does not stop the server render.
        </div>
      )}
      {researchContext && (
        <aside className="promo-research" aria-labelledby="promo-research-heading">
          <p className="eyebrow">Attributed creative context</p>
          <h2 id="promo-research-heading">Research for “{researchContext.topic}”</h2>
          <p>
            These references inform the creative direction. They are not verified facts about your
            business. Supply your own product details below and review the proposal before approval.
          </p>
          {researchContext.audience && (
            <p>
              <strong>Research audience:</strong> {researchContext.audience}
            </p>
          )}
          <details>
            <summary>Creative direction and sources</summary>
            <p className="promo-research-direction">{researchContext.creativeDirection}</p>
            {researchContext.evidence.length > 0 && (
              <div className="promo-research-evidence">
                <h3>Source excerpts</h3>
                {researchContext.evidence.map((evidence, index) => (
                  <blockquote key={`${evidence.postId}-${index}`}>
                    <p>{evidence.excerpt}</p>
                    <a href={evidence.url} target="_blank" rel="noreferrer noopener">
                      Open source <ArrowUpRight size={12} />
                    </a>
                    <span>
                      {evidence.contentKind === 'search_result'
                        ? 'Search result'
                        : evidence.contentKind === 'page'
                          ? 'Web page'
                          : 'Source post'}
                      {evidence.provider ? ` · ${evidence.provider}` : ''}
                    </span>
                  </blockquote>
                ))}
              </div>
            )}
            {researchContext.sourceUrls.length > 0 && (
              <div className="promo-research-sources">
                <h3>Saved source links</h3>
                <ul>
                  {researchContext.sourceUrls.map((url) => (
                    <li key={url}>
                      <a href={url} target="_blank" rel="noreferrer noopener">
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {researchContext.cautions.length > 0 && (
              <div className="promo-research-cautions">
                <h3>Limits to keep in mind</h3>
                <ul>
                  {researchContext.cautions.map((caution, index) => (
                    <li key={index}>{caution}</li>
                  ))}
                </ul>
              </div>
            )}
          </details>
        </aside>
      )}

      <section className="promo-section">
        <div className="promo-section-heading">
          <span className="promo-step">01</span>
          <div>
            <h2>The business behind the reel.</h2>
            <p>Keep business facts separate from creative inspiration.</p>
          </div>
        </div>
        <fieldset disabled={workflow ? !canEdit('brief') : Boolean(busy)} className="promo-fields">
          {!workflow && (
            <>
              <div className="field promo-wide">
                <label htmlFor="promo-input">What do you want to make?</label>
                <textarea
                  id="promo-input"
                  value={input}
                  maxLength={8000}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Make a welcoming promo for my neighborhood matcha shop. Show our drinks and invite people to visit this weekend."
                />
                <small>
                  Describe your own business, offer and goal. An incomplete idea is enough to start.
                </small>
              </div>
              <div className="field promo-wide">
                <label htmlFor="promo-title">
                  Promo name <span className="promo-optional">optional</span>
                </label>
                <input
                  id="promo-title"
                  value={title}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Weekend at our shop"
                />
              </div>
            </>
          )}
          {fields.map((field) => (
            <div className={`field ${field.large ? 'promo-wide' : ''}`} key={field.key}>
              <label htmlFor={`promo-${field.key}`}>{field.label}</label>
              {field.large ? (
                <textarea
                  id={`promo-${field.key}`}
                  value={draft.brief[field.key]}
                  maxLength={field.max}
                  onChange={(event) => editBrief(field.key, event.target.value)}
                />
              ) : (
                <input
                  id={`promo-${field.key}`}
                  value={draft.brief[field.key]}
                  maxLength={field.max}
                  onChange={(event) => editBrief(field.key, event.target.value)}
                />
              )}
              <small>{field.help}</small>
            </div>
          ))}
          <div className="field">
            <label htmlFor="promo-platform">Format for</label>
            <select
              id="promo-platform"
              value={draft.brief.platform}
              onChange={(event) => editBrief('platform', event.target.value)}
            >
              {Object.entries(platformNames).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="promo-tone">Tone</label>
            <select
              id="promo-tone"
              value={draft.brief.tone}
              onChange={(event) => editBrief('tone', event.target.value)}
            >
              {Object.entries(toneNames).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="promo-duration">Length</label>
            <select
              id="promo-duration"
              value={draft.brief.duration}
              onChange={(event) => editBrief('duration', Number(event.target.value))}
            >
              {[15, 30, 60].map((value) => (
                <option value={value} key={value}>
                  {value} seconds
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        {workflow && (
          <div className="promo-actions">
            <button
              className="button button-secondary"
              disabled={!flags.brief || !canEdit('brief')}
              onClick={() => save('brief')}
            >
              Save business details
            </button>
            <span className="promo-muted">
              Changing facts clears the old proposal and its approvals.
            </span>
          </div>
        )}
      </section>

      <section className="promo-section">
        <div className="promo-section-heading">
          <span className="promo-step">02</span>
          <div>
            <h2>Bring your product into frame.</h2>
            <p>Your actual photos become the video. JPEG, PNG or WebP, up to 10 MiB each.</p>
          </div>
        </div>
        <div className="promo-photo-grid">
          {workflow?.assets.map((asset) => (
            <article className="promo-photo" key={asset.id}>
              <img
                src={promoApi.assetUrl(workflow.id, asset.id)}
                alt={draft.descriptions[asset.id] || asset.filename}
                loading="lazy"
              />
              <div>
                <strong>{asset.filename}</strong>
                <span>
                  {asset.width} × {asset.height}
                </span>
                <label htmlFor={`asset-${asset.id}`}>What should we know about this photo?</label>
                <textarea
                  id={`asset-${asset.id}`}
                  value={draft.descriptions[asset.id] ?? ''}
                  maxLength={2000}
                  disabled={!canEdit('descriptions')}
                  onChange={(event) => {
                    setReviewed(false);
                    setDraft((previous) => ({
                      ...previous,
                      descriptions: { ...previous.descriptions, [asset.id]: event.target.value },
                    }));
                  }}
                />
                <button
                  className="text-button"
                  disabled={locked || hasEdits}
                  onClick={() =>
                    void run('Removing the photo', async (signal) => {
                      const latest = current.current!;
                      accept(
                        await promoApi.removeAsset(
                          workflow.id,
                          asset.id,
                          latest.workflow.version,
                          signal,
                        ),
                      );
                      setNotice('Photo removed. Prepare a new proposal before reviewing.');
                    })
                  }
                >
                  <Trash size={14} /> Remove photo
                </button>
              </div>
            </article>
          ))}
          {photos.map((photo) => (
            <article className="promo-photo promo-pending" key={photo.key}>
              <img src={photo.preview} alt={photo.description || photo.file.name} />
              <div>
                <strong>{photo.file.name}</strong>
                <span>Ready to upload</span>
                <label htmlFor={`pending-${photo.key}`}>Describe the product or moment</label>
                <textarea
                  id={`pending-${photo.key}`}
                  maxLength={2000}
                  value={photo.description}
                  disabled={Boolean(busy)}
                  onChange={(event) =>
                    setPhotos((previous) =>
                      previous.map((item) =>
                        item.key === photo.key
                          ? { ...item, description: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  className="text-button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    URL.revokeObjectURL(photo.preview);
                    setPhotos((previous) => previous.filter((item) => item.key !== photo.key));
                  }}
                >
                  <Trash size={14} /> Remove from upload
                </button>
              </div>
            </article>
          ))}
        </div>
        <label
          className={`promo-upload ${locked || (Object.values(flags).some(Boolean) && Boolean(workflow)) ? 'is-disabled' : ''}`}
        >
          <Image size={24} />
          <strong>Add your photos</strong>
          <span>{(workflow?.assets.length ?? 0) + photos.length} / 20 attached or queued</span>
          <input
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={addPhotos}
            disabled={
              locked ||
              Boolean(workflow && Object.values(flags).some(Boolean)) ||
              (workflow?.assets.length ?? 0) + photos.length >= 20
            }
          />
        </label>
        <p className="promo-muted">
          Add a useful description for each photo. Guided mode uses your descriptions; image
          interpretation depends on the configured provider.
        </p>
        {workflow && (
          <div className="promo-actions">
            {photos.length > 0 && (
              <button
                className="button button-primary"
                disabled={locked || Object.values(flags).some(Boolean)}
                onClick={() =>
                  void run('Uploading your photos', async (signal) => {
                    const next = await uploadQueued(current.current!, signal);
                    accept(next);
                    setNotice('Photos saved. Prepare the new proposal to include them.');
                  })
                }
              >
                Upload {photos.length} {photos.length === 1 ? 'photo' : 'photos'}{' '}
                <ArrowRight size={16} />
              </button>
            )}
            {flags.descriptions && (
              <button
                className="button button-secondary"
                disabled={!canEdit('descriptions')}
                onClick={() => save('descriptions')}
              >
                Save photo descriptions
              </button>
            )}
          </div>
        )}
      </section>

      {!workflow ? (
        <div className="promo-create-bar">
          <div>
            <strong>A real first draft, from your business.</strong>
            <p>We save your brief and photos, then prepare copy and scenes for your review.</p>
          </div>
          <button
            className="button button-primary"
            disabled={Boolean(busy) || uncertainCreation || !input.trim() || !photos.length}
            onClick={() =>
              void run('Saving your promo', async (signal) => {
                const created = await promoApi.create(
                  {
                    input: input.trim(),
                    ...(title.trim() ? { title: title.trim() } : {}),
                    brief: briefInput(draft.brief),
                    ...(research !== undefined ? { research } : {}),
                  },
                  signal,
                );
                notifyCreated.current = true;
                accept(created);
                const uploaded = await uploadQueued(created, signal);
                setBusy('Preparing copy and scenes');
                const prepared = await promoApi.prepare(
                  uploaded.workflow.id,
                  { expectedVersion: uploaded.workflow.version },
                  signal,
                );
                accept(prepared);
                notifyCreated.current = false;
                callback.current.onDirty(false);
                callback.current.onCreated(prepared.workflow.id);
              })
            }
          >
            Prepare my promo <ArrowUpRight size={18} />
          </button>
          {!photos.length && (
            <span className="promo-muted">Attach at least one photo to continue.</span>
          )}
          {uncertainCreation && (
            <div className="promo-notice">
              <p>
                The server may already have saved this promo. Check your promo library before
                creating another copy. Your form and queued photos are still here.
              </p>
              <button className="text-button" onClick={onBack}>
                Check my promo library <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <section className="promo-section">
            <div className="promo-section-heading">
              <span className="promo-step">03</span>
              <div>
                <h2>Give the idea its shape.</h2>
                <p>
                  {workflow.script?.provider === 'openai'
                    ? 'Model assisted proposal. Your review is the final check.'
                    : workflow.script?.provider === 'guided'
                      ? 'Guided proposal using structured templates and your supplied facts.'
                      : 'Prepare editable copy and a scene plan from your saved brief and photos.'}
                </p>
              </div>
            </div>
            <div className="promo-actions">
              <button
                className="button button-primary"
                disabled={locked || hasEdits || !workflow.assets.length}
                onClick={() => prepare(false)}
              >
                {workflow.script && workflow.scenes
                  ? 'Check saved proposal'
                  : 'Prepare copy and scenes'}{' '}
                <ArrowRight size={16} />
              </button>
              {workflow.script && (
                <button
                  className="text-button"
                  disabled={locked || hasEdits}
                  onClick={() => setReplaceConfirm((value) => !value)}
                >
                  Replace proposal
                </button>
              )}
            </div>
            {replaceConfirm && (
              <div className="promo-notice">
                <p>This replaces the current copy and scene plan and clears their approvals.</p>
                <button
                  className="button button-secondary"
                  disabled={locked || hasEdits}
                  onClick={() => prepare(true)}
                >
                  Replace with a new proposal
                </button>
                <button className="text-button" onClick={() => setReplaceConfirm(false)}>
                  Keep current proposal
                </button>
              </div>
            )}

            {workflow.questions.some((question) => question.status === 'open') && (
              <div className="promo-followups">
                <h3>A little more direction.</h3>
                <p>
                  Answer what you know. Optional questions can stay open; the checks below identify
                  anything required.
                </p>
                <fieldset disabled={!canEdit('refinement')} className="promo-fields">
                  {workflow.questions
                    .filter((question) => question.status === 'open')
                    .map((question) => (
                      <div className="field promo-wide" key={question.id}>
                        <label htmlFor={`question-${question.id}`}>{question.question}</label>
                        <textarea
                          id={`question-${question.id}`}
                          value={answers[question.field] ?? ''}
                          maxLength={
                            question.field === 'productName'
                              ? 120
                              : question.field === 'imageDirection'
                                ? 2000
                                : 4000
                          }
                          onChange={(event) => {
                            setReviewed(false);
                            setAnswers((previous) => ({
                              ...previous,
                              [question.field]: event.target.value,
                            }));
                          }}
                        />
                      </div>
                    ))}
                </fieldset>
              </div>
            )}
            <div className="field promo-refinement">
              <label htmlFor="promo-refinement">Anything you want to change?</label>
              <textarea
                id="promo-refinement"
                value={refinement}
                maxLength={8000}
                disabled={!canEdit('refinement')}
                onChange={(event) => {
                  setReviewed(false);
                  setRefinement(event.target.value);
                }}
                placeholder="Make it more welcoming. Focus on the strawberry matcha and invite people to visit on Saturday."
              />
              <small>
                Use the business details above for factual changes. Free text interpretation depends
                on the configured provider.
              </small>
            </div>
            <button
              className="button button-secondary"
              disabled={!flags.refinement || !canEdit('refinement')}
              onClick={() => save('refinement')}
            >
              Apply direction and prepare
            </button>

            {draft.script && (
              <div className="promo-script">
                <div className="promo-subheading">
                  <h3>The copy.</h3>
                  <span>
                    {draft.script.segments.reduce((total, segment) => total + segment.seconds, 0)} /{' '}
                    {workflow.brief.duration ?? 15} seconds
                  </span>
                </div>
                <fieldset disabled={!canEdit('script')}>
                  <div className="field">
                    <label htmlFor="promo-hook">Opening hook</label>
                    <textarea
                      id="promo-hook"
                      value={draft.script.hook}
                      maxLength={1000}
                      onChange={(event) => {
                        setReviewed(false);
                        setDraft((previous) =>
                          previous.script
                            ? {
                                ...previous,
                                script: { ...previous.script, hook: event.target.value },
                              }
                            : previous,
                        );
                      }}
                    />
                  </div>
                  {draft.script.segments.map((segment, index) => (
                    <div className="promo-segment" key={segment.id}>
                      <div className="field">
                        <label htmlFor={`segment-${segment.id}`}>Moment {index + 1}</label>
                        <textarea
                          id={`segment-${segment.id}`}
                          maxLength={2000}
                          value={segment.text}
                          onChange={(event) => {
                            setReviewed(false);
                            setDraft((previous) =>
                              previous.script
                                ? {
                                    ...previous,
                                    script: {
                                      ...previous.script,
                                      segments: previous.script.segments.map((item) =>
                                        item.id === segment.id
                                          ? { ...item, text: event.target.value }
                                          : item,
                                      ),
                                    },
                                  }
                                : previous,
                            );
                          }}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`seconds-${segment.id}`}>Seconds</label>
                        <input
                          id={`seconds-${segment.id}`}
                          type="number"
                          min={1}
                          max={60}
                          step={1}
                          value={segment.seconds}
                          onChange={(event) => {
                            setReviewed(false);
                            setDraft((previous) =>
                              previous.script
                                ? {
                                    ...previous,
                                    script: {
                                      ...previous.script,
                                      segments: previous.script.segments.map((item) =>
                                        item.id === segment.id
                                          ? { ...item, seconds: Number(event.target.value) }
                                          : item,
                                      ),
                                    },
                                  }
                                : previous,
                            );
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="field">
                    <label htmlFor="promo-caption">Caption for your post</label>
                    <textarea
                      id="promo-caption"
                      value={draft.script.caption}
                      maxLength={3000}
                      onChange={(event) => {
                        setReviewed(false);
                        setDraft((previous) =>
                          previous.script
                            ? {
                                ...previous,
                                script: { ...previous.script, caption: event.target.value },
                              }
                            : previous,
                        );
                      }}
                    />
                  </div>
                </fieldset>
                <div className="promo-actions">
                  <button
                    className="button button-secondary"
                    disabled={!flags.script || !canEdit('script')}
                    onClick={() => save('script')}
                  >
                    Save copy
                  </button>
                  <span className="promo-muted">
                    Saving copy clears the old scenes. Prepare again to rebuild them.
                  </span>
                </div>
              </div>
            )}

            {draft.scenes && (
              <div className="promo-scenes">
                <div className="promo-subheading">
                  <h3>The scene plan.</h3>
                  <span>
                    {draft.scenes.reduce((total, scene) => total + scene.seconds, 0)} seconds ·{' '}
                    {draft.scenes.length} scenes
                  </span>
                </div>
                <fieldset disabled={!canEdit('scenes')}>
                  <div className="promo-scene-list">
                    {draft.scenes.map((scene, index) => (
                      <article className="promo-scene" key={scene.id}>
                        <div className="promo-scene-heading">
                          <strong>Scene {index + 1}</strong>
                          <span>
                            {workflow.script?.segments.findIndex(
                              (segment) => segment.id === scene.scriptSegmentId,
                            )! +
                              1 >
                            0
                              ? `Copy moment ${workflow.script?.segments.findIndex((segment) => segment.id === scene.scriptSegmentId)! + 1}`
                              : 'Copy segment missing'}
                          </span>
                        </div>
                        <div className="field">
                          <label htmlFor={`visual-${scene.id}`}>Visual direction</label>
                          <textarea
                            id={`visual-${scene.id}`}
                            value={scene.visual}
                            maxLength={2000}
                            onChange={(event) => {
                              setReviewed(false);
                              setDraft((previous) => ({
                                ...previous,
                                scenes:
                                  previous.scenes?.map((item) =>
                                    item.id === scene.id
                                      ? { ...item, visual: event.target.value }
                                      : item,
                                  ) ?? null,
                              }));
                            }}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`screen-${scene.id}`}>On screen text</label>
                          <textarea
                            id={`screen-${scene.id}`}
                            value={scene.onScreenText}
                            maxLength={500}
                            onChange={(event) => {
                              setReviewed(false);
                              setDraft((previous) => ({
                                ...previous,
                                scenes:
                                  previous.scenes?.map((item) =>
                                    item.id === scene.id
                                      ? { ...item, onScreenText: event.target.value }
                                      : item,
                                  ) ?? null,
                              }));
                            }}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`timing-${scene.id}`}>Seconds</label>
                          <input
                            id={`timing-${scene.id}`}
                            type="number"
                            min={1}
                            max={60}
                            step={1}
                            value={scene.seconds}
                            onChange={(event) => {
                              setReviewed(false);
                              setDraft((previous) => ({
                                ...previous,
                                scenes:
                                  previous.scenes?.map((item) =>
                                    item.id === scene.id
                                      ? { ...item, seconds: Number(event.target.value) }
                                      : item,
                                  ) ?? null,
                              }));
                            }}
                          />
                        </div>
                        <div className="promo-scene-assets">
                          <span>Photos in this scene</span>
                          {workflow.assets.map((asset) => (
                            <label key={asset.id}>
                              <input
                                type="checkbox"
                                checked={scene.assetIds.includes(asset.id)}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setReviewed(false);
                                  setDraft((previous) => ({
                                    ...previous,
                                    scenes:
                                      previous.scenes?.map((item) =>
                                        item.id === scene.id
                                          ? {
                                              ...item,
                                              assetIds: checked
                                                ? [...item.assetIds, asset.id]
                                                : item.assetIds.filter(
                                                    (value) => value !== asset.id,
                                                  ),
                                            }
                                          : item,
                                      ) ?? null,
                                  }));
                                }}
                              />
                              <img
                                src={promoApi.assetUrl(workflow.id, asset.id)}
                                alt=""
                                loading="lazy"
                              />
                              <span>{asset.description || asset.filename}</span>
                            </label>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </fieldset>
                <button
                  className="button button-secondary"
                  disabled={!flags.scenes || !canEdit('scenes')}
                  onClick={() => save('scenes')}
                >
                  Save scene plan
                </button>
              </div>
            )}
          </section>

          <section className="promo-section promo-review">
            <div className="promo-section-heading">
              <span className="promo-step">04</span>
              <div>
                <h2>Your name goes on it.</h2>
                <p>
                  Check the facts, copy, timing and photo choices. Approval applies to this saved
                  proposal only.
                </p>
              </div>
            </div>
            <div className="promo-checks">
              {reports.map((report) => (
                <details
                  className={`promo-check promo-check-${report.state}`}
                  key={report.stage}
                  open={report.state === 'blocked'}
                >
                  <summary>
                    <span>
                      {report.stage === 'brief'
                        ? 'Business facts'
                        : report.stage === 'script'
                          ? 'Copy'
                          : 'Scenes'}
                    </span>
                    <strong>
                      {report.state === 'approved'
                        ? 'Approved'
                        : report.state === 'blocked'
                          ? 'Needs a fix'
                          : 'Needs your review'}
                    </strong>
                  </summary>
                  <ul>
                    {report.checks
                      .filter((check) => !check.passed)
                      .map((check, index) => (
                        <li key={`${check.code}-${index}`}>
                          <span>{check.severity === 'error' ? 'Required' : 'Note'}</span>
                          {check.message}
                          {check.path && <small>{check.path}</small>}
                        </li>
                      ))}
                    {report.checks.every((check) => check.passed) && (
                      <li>Checks passed. Confirm the content is accurate before approving.</li>
                    )}
                  </ul>
                </details>
              ))}
            </div>
            {hasEdits && (
              <p className="promo-muted">
                Save your edits before reviewing. Old approvals and exports do not cover local
                changes.
              </p>
            )}
            <label className="promo-approval">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={!canReview}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              <span>
                I reviewed the business facts, copy, timings and photo choices. I approve this
                version for rendering.
              </span>
            </label>
            <button
              className="button button-primary"
              disabled={!reviewed || !canReview}
              onClick={approveAndRender}
            >
              {job?.status === 'failed' ? 'Approve and retry render' : 'Approve and render video'}{' '}
              <ArrowUpRight size={18} />
            </button>
            <p className="promo-muted">
              This creates a silent video from your photos. It does not generate new footage, record
              voiceover or post to social accounts.
            </p>
          </section>

          {(job || currentOutput) && (
            <section className="promo-section promo-output">
              <div className="promo-section-heading">
                <span className="promo-step">05</span>
                <div>
                  <h2>
                    {currentOutput
                      ? 'Out of your head. Ready to share.'
                      : rendering
                        ? 'Your promo is taking shape.'
                        : job?.status === 'failed'
                          ? 'Let’s get this export ready.'
                          : 'Your exports.'}
                  </h2>
                  <p>
                    {currentOutput
                      ? 'Watch the whole video, then take the MP4 and caption to your chosen platform.'
                      : 'A queued render is still processing. A completed older export stays separate from your current proposal.'}
                  </p>
                </div>
              </div>
              {rendering && (
                <div className="promo-render-state" role="status">
                  <div className="promo-render-track">
                    <span />
                  </div>
                  <strong>
                    {job?.status === 'queued' ? 'Queued for rendering' : 'Rendering your video'}
                  </strong>
                  <span>
                    {polling
                      ? 'Checking the real render job. You can leave and resume from your promo library.'
                      : 'Status checks paused. The server is still working on this job.'}
                  </span>
                  <div className="promo-actions">
                    {polling ? (
                      <button
                        className="text-button"
                        onClick={() => {
                          pollController.current?.abort();
                          setPolling(false);
                          setNotice('Stopped checking status. The server render continues.');
                        }}
                      >
                        Stop checking
                      </button>
                    ) : (
                      job && (
                        <button
                          className="button button-secondary"
                          onClick={() => startPolling(job)}
                        >
                          Check render status
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}
              {job?.status === 'failed' && (
                <div className="promo-notice">
                  <strong>{job.error?.code ?? 'Render failed'}</strong>
                  <p>
                    {job.error?.message ??
                      'Review the proposal and photos, then approve a new render.'}
                  </p>
                  <p>
                    Correct anything needed above, review again, and use “Approve and retry render”.
                  </p>
                </div>
              )}
              {currentOutput && kit && (
                <div className="promo-output-grid">
                  <div className="promo-video">
                    <video
                      controls
                      playsInline
                      preload="metadata"
                      src={promoApi.videoUrl(workflow.id, kit.video.jobId)}
                      aria-label={`Completed promo for ${workflow.title}`}
                    />
                    <span>1080 × 1920 · {kit.video.duration}s · Silent</span>
                  </div>
                  <div className="promo-handoff">
                    <h3>Your next post.</h3>
                    <p>This file is ready for your review and manual upload.</p>
                    <a
                      className="button button-primary"
                      href={promoApi.videoUrl(workflow.id, kit.video.jobId, true)}
                      download
                    >
                      <DownloadSimple size={18} /> Download MP4
                    </a>
                    <label htmlFor="ready-caption">Post caption</label>
                    <textarea id="ready-caption" value={kit.caption} readOnly rows={7} />
                    <div className="promo-actions">
                      <button className="button button-secondary" onClick={downloadCaption}>
                        Download caption
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(kit.caption)
                            .then(() => setNotice('Caption copied.'))
                            .catch(() => setNotice('Select the caption text to copy it.'))
                        }
                      >
                        Copy caption
                      </button>
                    </div>
                    <span className="promo-muted">
                      No account was connected and nothing was posted automatically.
                    </span>
                  </div>
                </div>
              )}
              {!currentOutput && job?.status === 'succeeded' && (
                <div className="promo-notice">
                  <p>
                    This is an earlier export or its current version has not been verified. It does
                    not reflect any newer edits.
                  </p>
                  <div className="promo-actions">
                    <a
                      className="text-button"
                      href={promoApi.videoUrl(workflow.id, job.id, true)}
                      download
                    >
                      Download earlier export <DownloadSimple size={16} />
                    </a>
                    <button
                      className="text-button"
                      disabled={hasEdits || Boolean(busy)}
                      onClick={() => startPolling(job)}
                    >
                      Verify current export
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
