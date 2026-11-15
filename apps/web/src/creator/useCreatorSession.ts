import { useEffect, useRef, useState } from 'react';
import type { SocialHandoff } from '@yap/contracts/social';
import type { Workflow } from '@yap/contracts/workflow';
import type {
  CreatorCapabilities,
  CreatorExternalReference,
  CreatorJob,
  CreatorJobResponse,
  CreatorQuestion,
  CreatorQuote,
  CreatorBudgetSnapshot,
  CreatorSessionResponse,
} from '@yap/contracts/creator';
import { promoApi, PromoApiError } from '../promo/api';
import { creatorApi, CreatorApiError, creatorMessage } from './api';
import {
  checkedPhotos,
  approvalCurrent,
  generatedSeconds,
  isActiveJob,
  planCurrent,
  outputIsCurrent,
  planDraft,
  sourceInput,
  startingPrompt,
  withAnswer,
} from './model';
import {
  browserRequestStorage,
  productionDecision,
  readProductionRequest,
  saveProductionRequest,
} from './production';
import { quoteIsAffordable, quoteIsCurrent, readSavedQuote, saveQuote } from './quote';

export type PendingPhoto = { id: string; file: File; preview: string; description: string };
export type SourceForm = {
  mode: 'media' | 'text';
  prompt: string;
  location: string;
  urls: string;
  platform: 'instagram' | 'tiktok' | 'youtube';
  duration: 15 | 30 | 60;
  tone: 'conversational' | 'educational' | 'bold';
};
type ScriptDraft = NonNullable<Workflow['script']>;
const emptySource: SourceForm = {
  mode: 'text',
  prompt: '',
  location: '',
  urls: '',
  platform: 'instagram',
  duration: 15,
  tone: 'conversational',
};
const serialize = (value: unknown) => JSON.stringify(value);
const sourceForm = (state: CreatorSessionResponse): SourceForm => ({
  mode: state.session.input.mode,
  prompt: state.session.input.prompt,
  location: state.session.input.location ?? '',
  urls: state.session.input.urls.join('\n'),
  platform: state.session.input.platform ?? 'instagram',
  duration: state.session.input.duration ?? 15,
  tone: state.session.input.tone ?? 'conversational',
});
const wait = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, 1200);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });

export function useCreatorSession(options: {
  id?: string;
  initialResearch?: SocialHandoff;
  initialExternalReferences?: CreatorExternalReference[];
  onCreated(id: string): void;
  onDirty(value: boolean): void;
}) {
  const [state, setState] = useState<CreatorSessionResponse | null>(null);
  const [capabilities, setCapabilities] = useState<CreatorCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [quote, setQuote] = useState<CreatorQuote | null>(null);
  const [budget, setBudget] = useState<CreatorBudgetSnapshot | null>(null);
  const [budgetError, setBudgetError] = useState('');
  const [source, setSource] = useState<SourceForm>(emptySource);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [plan, setPlan] = useState<ReturnType<typeof planDraft>>(null);
  const [script, setScript] = useState<ScriptDraft | null>(null);
  const [reply, setReply] = useState('');
  const [replyQuestion, setReplyQuestion] = useState<CreatorQuestion | null>(null);
  const [answerEdits, setAnswerEdits] = useState<Record<string, string>>({});
  const [photoEdits, setPhotoEdits] = useState<Record<string, string>>({});
  const [externalReferences, setExternalReferences] = useState<CreatorExternalReference[]>(() =>
    structuredClone(options.initialExternalReferences ?? []),
  );
  const [job, setJob] = useState<CreatorJob | null>(null);
  const [watching, setWatching] = useState(false);
  const [loading, setLoading] = useState(Boolean(options.id));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const current = useRef(state);
  const callbacks = useRef(options);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const poll = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const photoRef = useRef(photos);
  const hydratedId = useRef<string | null>(null);
  const planBase = useRef<string | null>(null);
  const scriptBase = useRef<string | null>(null);
  const quoteRef = useRef<CreatorQuote | null>(null);
  const budgetSequence = useRef(0);

  const inputDirty = state
    ? serialize(source) !== serialize(sourceForm(state))
    : Boolean(source.prompt || source.location || source.urls);
  const planDirty = serialize(plan) !== serialize(planDraft(state?.session.plan ?? null));
  const scriptDirty = serialize(script) !== serialize(state?.workflow.script ?? null);
  const answersDirty = Object.entries(answerEdits).some(
    ([id, value]) =>
      value !== state?.session.answers.find((answer) => answer.questionId === id)?.answer,
  );
  const photoEditsDirty = Object.entries(photoEdits).some(
    ([id, value]) => value !== state?.workflow.assets.find((asset) => asset.id === id)?.description,
  );
  const dirty =
    inputDirty ||
    planDirty ||
    scriptDirty ||
    photos.length > 0 ||
    Boolean(reply.trim()) ||
    answersDirty ||
    photoEditsDirty ||
    (!state && externalReferences.length > 0);
  const flags = useRef({ inputDirty, planDirty, scriptDirty });
  flags.current = { inputDirty, planDirty, scriptDirty };
  current.current = state;
  callbacks.current = options;
  photoRef.current = photos;

  function accept(next: CreatorSessionResponse, reset = false) {
    if (!mounted.current) return;
    const previous = current.current;
    if (previous?.session.id === next.session.id && previous.session.version > next.session.version)
      return;
    current.current = next;
    setState(next);
    const first = hydratedId.current !== next.session.id;
    if (reset || first) {
      setSource(sourceForm(next));
      setReply('');
      setReplyQuestion(null);
      setAnswerEdits({});
      setPhotoEdits({});
      setExternalReferences(next.session.externalReferences);
    }
    if (
      reset ||
      first ||
      (!flags.current.planDirty && planBase.current !== next.session.plan?.id)
    ) {
      setPlan(planDraft(next.session.plan));
      planBase.current = next.session.plan?.id ?? null;
    }
    if (
      reset ||
      first ||
      (!flags.current.scriptDirty && scriptBase.current !== next.workflow.script?.id)
    ) {
      setScript(next.workflow.script ? structuredClone(next.workflow.script) : null);
      scriptBase.current = next.workflow.script?.id ?? null;
    }
    hydratedId.current = next.session.id;
  }

  function acceptJob(next: CreatorJobResponse) {
    if (!mounted.current) return;
    setJob(next.job);
    const quoted = quoteRef.current;
    if (quoted && next.job.kind === 'production' && next.job.quoteId === quoted.id) {
      const consumed = {
        ...quoted,
        consumedByJobId: next.job.id,
        approvedApprovalId: next.job.approvalId,
      };
      acceptQuote(consumed);
      try {
        saveQuote(browserRequestStorage(), consumed);
      } catch {
        setNotice(
          'The run was accepted by the server. Use saved job activity to reconnect if browser storage is unavailable.',
        );
      }
    }
    const saved = current.current;
    if (saved?.session.id === next.session.id)
      accept({ session: next.session, workflow: saved.workflow });
  }

  function acceptQuote(next: CreatorQuote | null) {
    quoteRef.current = next;
    setQuote(next);
  }

  function acceptBudget(next: CreatorBudgetSnapshot) {
    budgetSequence.current += 1;
    setBudget(next);
    setBudgetError('');
  }

  async function loadBudget(signal?: AbortSignal) {
    const sequence = ++budgetSequence.current;
    try {
      const response = await creatorApi.budget(signal);
      if (!signal?.aborted && mounted.current && sequence === budgetSequence.current) {
        setBudget(response.budget);
        setBudgetError('');
      }
    } catch (caught) {
      if (!signal?.aborted && mounted.current && sequence === budgetSequence.current)
        setBudgetError(`The shared app budget could not be refreshed. ${creatorMessage(caught)}`);
    }
  }

  function watch(initial: CreatorJob) {
    poll.current?.abort();
    const active = new AbortController();
    poll.current = active;
    setJob(initial);
    setWatching(true);
    void (async () => {
      let snapshot = initial;
      try {
        while (!active.signal.aborted) {
          const response = await creatorApi.job(snapshot.sessionId, snapshot.id, active.signal);
          if (active.signal.aborted) return;
          snapshot = response.job;
          acceptJob(response);
          if (!isActiveJob(snapshot)) {
            accept(await creatorApi.get(snapshot.sessionId, active.signal));
            void loadBudget(active.signal);
            if (snapshot.status === 'failed')
              setError(
                snapshot.error?.message ??
                  'This job could not finish. Review the activity and try again.',
              );
            else if (snapshot.status === 'succeeded')
              setNotice(
                snapshot.kind === 'analysis'
                  ? 'Research is saved. Review the sources and add your direction.'
                  : 'Your film is ready to watch.',
              );
            return;
          }
          await wait(active.signal);
        }
      } catch (caught) {
        if (!active.signal.aborted && mounted.current)
          setError(`Status updates stopped. ${creatorMessage(caught)}`);
      } finally {
        if (poll.current === active) {
          poll.current = null;
          if (mounted.current) setWatching(false);
        }
      }
    })();
  }

  useEffect(() => {
    options.onDirty(dirty);
  }, [dirty, options.onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      poll.current?.abort();
      photoRef.current.forEach((photo) => URL.revokeObjectURL(photo.preview));
      callbacks.current.onDirty(false);
    };
  }, []);

  useEffect(() => {
    const active = new AbortController();
    void creatorApi
      .capabilities(active.signal)
      .then((value) => {
        if (!active.signal.aborted) {
          setCapabilities(value);
          setCapabilityError('');
        }
      })
      .catch((caught) => {
        if (!active.signal.aborted) setCapabilityError(creatorMessage(caught));
      });
    return () => active.abort();
  }, [reloadKey]);

  useEffect(() => {
    const active = new AbortController();
    void loadBudget(active.signal);
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadBudget(active.signal);
    }, 15_000);
    return () => {
      active.abort();
      clearInterval(timer);
    };
  }, [reloadKey]);

  useEffect(() => {
    const id = options.id ?? current.current?.session.id;
    if (!id) return;
    const active = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([creatorApi.get(id, active.signal), creatorApi.jobs(id, active.signal)])
      .then(([next, history]) => {
        if (active.signal.aborted) return;
        accept(next);
        try {
          const restored = readSavedQuote(browserRequestStorage(), next.session.id);
          const submitted = restored && history.jobs.find((item) => item.quoteId === restored.id);
          acceptQuote(
            restored && submitted
              ? {
                  ...restored,
                  consumedByJobId: submitted.id,
                  approvedApprovalId: submitted.approvalId,
                }
              : restored,
          );
        } catch (caught) {
          acceptQuote(null);
          setNotice(creatorMessage(caught));
        }
        setNeedsReload(false);
        const ordered = [...history.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const latest = ordered.find((candidate) => isActiveJob(candidate)) ?? ordered[0] ?? null;
        setJob(latest);
        if (latest && isActiveJob(latest)) watch(latest);
      })
      .catch((caught) => {
        if (!active.signal.aborted) setError(creatorMessage(caught));
      })
      .finally(() => {
        if (!active.signal.aborted) setLoading(false);
      });
    return () => {
      active.abort();
      poll.current?.abort();
    };
  }, [options.id, reloadKey]);

  async function run(
    label: string,
    work: (signal: AbortSignal) => Promise<void>,
    rejectOnFailure = false,
  ) {
    if (operation.current) {
      if (rejectOnFailure)
        throw new Error(
          'Wait for the current studio action to finish, then try saving this reference again.',
        );
      return;
    }
    operation.current = true;
    const active = new AbortController();
    controller.current = active;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await work(active.signal);
      if (rejectOnFailure && (active.signal.aborted || !mounted.current))
        throw new DOMException(
          'Reference saving was canceled. Reload the saved creation before trying again.',
          'AbortError',
        );
    } catch (caught) {
      if (active.signal.aborted || !mounted.current) {
        if (rejectOnFailure) throw caught;
        return;
      }
      setError(creatorMessage(caught));
      const quoteIssue =
        caught instanceof CreatorApiError &&
        [
          'CREATOR_QUOTE_EXPIRED',
          'CREATOR_QUOTE_CONSUMED',
          'CREATOR_BUDGET_EXCEEDED',
          'CREATOR_ATTEMPTS_EXHAUSTED',
        ].includes(caught.code);
      if (quoteIssue) {
        acceptQuote(null);
        void loadBudget();
      }
      if (
        !quoteIssue &&
        (caught instanceof CreatorApiError || caught instanceof PromoApiError) &&
        (caught.status === 409 || ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(caught.code))
      ) {
        setNeedsReload(true);
        setNotice(
          'The saved state may have changed. Local text is still here. Reload the saved state before retrying.',
        );
      }
      if (rejectOnFailure) throw caught;
    } finally {
      if (controller.current === active) {
        controller.current = null;
        operation.current = false;
        if (mounted.current) setBusy('');
      }
    }
  }

  function guardDrafts(
    allowed: 'source' | 'reply' | 'plan' | 'script' | 'answers' | 'photo' | 'none',
  ) {
    if (
      (allowed !== 'source' && (flags.current.inputDirty || photoRef.current.length > 0)) ||
      (allowed !== 'reply' && reply.trim()) ||
      (allowed !== 'answers' && answersDirty) ||
      (allowed !== 'photo' && photoEditsDirty) ||
      (allowed !== 'plan' && flags.current.planDirty) ||
      (allowed !== 'script' && flags.current.scriptDirty)
    ) {
      throw new Error(
        'Save or discard your other local text, answers or shot edits before this action. Your edits are still here.',
      );
    }
  }

  function addPhotos(files: File[]) {
    try {
      checkedPhotos(files, state?.workflow.assets.length ?? 0, photos.length);
      setPhotos((previous) => [
        ...previous,
        ...files.map((file) => ({
          id: crypto.randomUUID(),
          file,
          preview: URL.createObjectURL(file),
          description: '',
        })),
      ]);
      setSource((previous) => ({ ...previous, mode: 'media' }));
      setError('');
    } catch (caught) {
      setError(creatorMessage(caught));
    }
  }

  async function uploadQueued(saved: CreatorSessionResponse, signal: AbortSignal) {
    let workflow = saved.workflow;
    const queued = [...photoRef.current];
    for (const [index, photo] of queued.entries()) {
      setBusy(`Saving photo ${index + 1} of ${queued.length}`);
      if (!crypto.subtle)
        throw new Error('Uploads need HTTPS or localhost. Your queued photos are still here.');
      const digest = await crypto.subtle.digest('SHA-256', await photo.file.arrayBuffer());
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      signal.throwIfAborted();
      let added = workflow.assets.find((asset) => asset.sha256 === hash);
      if (!added) {
        const uploaded = await promoApi.upload(workflow.id, workflow.version, photo.file, signal);
        added = uploaded.workflow.assets.find(
          (asset) => !workflow.assets.some((existing) => existing.id === asset.id),
        );
        workflow = uploaded.workflow;
      }
      if (added && photo.description.trim())
        workflow = (
          await promoApi.describeAsset(
            workflow.id,
            added.id,
            workflow.version,
            photo.description.trim(),
            signal,
          )
        ).workflow;
      accept({ session: saved.session, workflow });
      URL.revokeObjectURL(photo.preview);
      setPhotos((previous) => previous.filter((item) => item.id !== photo.id));
    }
    return creatorApi.get(saved.session.id, signal);
  }

  function create() {
    void run('Saving your starting point', async (signal) => {
      const input = sourceInput(
        source.mode,
        startingPrompt(source.prompt, photoRef.current.length),
        source.location,
        source.urls,
        {
          platform: source.platform,
          duration: source.duration,
          tone: source.tone,
        },
      );
      let next = await creatorApi.create(
        {
          input,
          externalReferences,
          ...(callbacks.current.initialResearch
            ? { research: callbacks.current.initialResearch }
            : {}),
        },
        signal,
      );
      accept(next, true);
      next = await uploadQueued(next, signal);
      accept(next, true);
      try {
        const result = await creatorApi.analyze(next.session.id, next.session.version, signal);
        acceptJob(result);
        watch(result.job);
      } finally {
        if (!signal.aborted) {
          callbacks.current.onDirty(false);
          callbacks.current.onCreated(next.session.id);
        }
      }
    });
  }

  function saveSources() {
    const saved = current.current;
    if (!saved) return;
    void run('Saving your sources', async (signal) => {
      guardDrafts('source');
      const input = sourceInput(source.mode, source.prompt, source.location, source.urls, {
        platform: source.platform,
        duration: source.duration,
        tone: source.tone,
      });
      let next = flags.current.inputDirty
        ? await creatorApi.patch(
            saved.session.id,
            { expectedVersion: saved.session.version, input },
            signal,
          )
        : saved;
      accept(next, true);
      next = await uploadQueued(next, signal);
      accept(next, true);
      setNotice(
        'Sources saved. Research and the shot plan must be refreshed after changing the input.',
      );
      if (!callbacks.current.id && !signal.aborted) {
        callbacks.current.onDirty(false);
        callbacks.current.onCreated(next.session.id);
      }
    });
  }

  function answer(questionId: string) {
    const saved = current.current;
    if (!saved || !reply.trim()) return;
    void run('Saving your direction', async (signal) => {
      guardDrafts('reply');
      accept(
        await creatorApi.patch(
          saved.session.id,
          {
            expectedVersion: saved.session.version,
            answers: withAnswer(saved.session.answers, questionId, reply),
          },
          signal,
        ),
        true,
      );
      setReply('');
      setNotice('Your answer is saved with this film.');
    });
  }

  function selectReference(id: string) {
    const saved = current.current;
    if (!saved) return;
    const ids = saved.session.selectedReferenceIds;
    void run('Saving your reference', async (signal) => {
      guardDrafts('none');
      accept(
        await creatorApi.patch(
          saved.session.id,
          {
            expectedVersion: saved.session.version,
            selectedReferenceIds: ids.includes(id)
              ? ids.filter((value) => value !== id)
              : [...ids, id],
          },
          signal,
        ),
        true,
      );
    });
  }

  async function saveExternalReference(reference: CreatorExternalReference): Promise<void> {
    const saved = current.current;
    const previous = saved?.session.externalReferences ?? externalReferences;
    const next = [...previous.filter((item) => item.id !== reference.id), reference];
    if (next.length > 12) {
      const message = 'Choose up to 12 film references. Remove one before adding another.';
      setNotice('');
      setError(message);
      throw new Error(message);
    }
    if (!saved) {
      setExternalReferences(next);
      return;
    }
    await run(
      'Saving selected techniques',
      async (signal) => {
        guardDrafts('none');
        accept(
          await creatorApi.patch(
            saved.session.id,
            { expectedVersion: saved.session.version, externalReferences: next },
            signal,
          ),
          true,
        );
        setNotice('Selected techniques saved as creative context. No campaign media was copied.');
      },
      true,
    );
  }

  function selectExternal(reference: CreatorExternalReference) {
    // The reference room has fire-and-forget callbacks; their errors remain in the
    // controller. Panels needing a confirmation await saveExternalReference instead.
    void saveExternalReference(reference).catch(() => undefined);
  }

  function removeExternal(id: string) {
    const next = (state?.session.externalReferences ?? externalReferences).filter(
      (item) => item.id !== id,
    );
    if (!state) {
      setExternalReferences(next);
      return;
    }
    const saved = current.current!;
    void run('Removing the reference', async (signal) => {
      guardDrafts('none');
      accept(
        await creatorApi.patch(
          saved.session.id,
          { expectedVersion: saved.session.version, externalReferences: next },
          signal,
        ),
        true,
      );
    });
  }

  function analyze() {
    const saved = current.current;
    if (!saved) return;
    void run('Starting research', async (signal) => {
      guardDrafts('none');
      const next = await creatorApi.analyze(saved.session.id, saved.session.version, signal);
      acceptJob(next);
      watch(next.job);
    });
  }

  function prepare() {
    const saved = current.current;
    if (!saved) return;
    void run('Preparing your script and shots', async (signal) => {
      guardDrafts('none');
      try {
        accept(
          await creatorApi.prepare(
            saved.session.id,
            {
              expectedVersion: saved.session.version,
              expectedWorkflowVersion: saved.workflow.version,
            },
            signal,
          ),
          true,
        );
      } catch (caught) {
        if (
          !(caught instanceof CreatorApiError) ||
          caught.code !== 'CREATOR_PREPARE_REVIEW_REQUIRED'
        )
          throw caught;
        accept(await creatorApi.get(saved.session.id, signal));
        setNeedsReload(false);
        setError(caught.message);
        setNotice(
          'Your saved drafting progress is available. Edit the saved script timing, then prepare the plan again. No drafting request was automatically repeated.',
        );
        return;
      }
      setNotice('Your script and shot plan are ready to review. No paid clips have been started.');
    });
  }

  function savePlan() {
    const saved = current.current;
    if (!saved || !plan) return;
    void run('Saving the shot plan', async (signal) => {
      guardDrafts('plan');
      if (planBase.current !== saved.session.plan?.id)
        throw new Error(
          'The saved shot plan has changed. Use the saved draft before editing this version.',
        );
      accept(
        await creatorApi.savePlan(
          saved.session.id,
          {
            expectedVersion: saved.session.version,
            expectedWorkflowVersion: saved.workflow.version,
            ...plan,
          },
          signal,
        ),
        true,
      );
      setNotice('Shot changes saved. Review this version again before generating clips.');
    });
  }

  function saveScript() {
    const saved = current.current;
    if (!saved || !script) return;
    void run('Saving your script', async (signal) => {
      guardDrafts('script');
      if (scriptBase.current !== saved.workflow.script?.id)
        throw new Error(
          'The saved script has changed. Use the saved draft before editing this version.',
        );
      const updated = await promoApi.updateScript(
        saved.workflow.id,
        {
          expectedVersion: saved.workflow.version,
          hook: script.hook,
          caption: script.caption,
          segments: script.segments,
        },
        signal,
      );
      accept({ session: saved.session, workflow: updated.workflow });
      accept(await creatorApi.get(saved.session.id, signal), true);
      setNotice('Script saved. Prepare again to rebuild its shot plan before approving.');
    });
  }

  function requestQuote() {
    const saved = current.current;
    if (
      !saved?.session.plan ||
      dirty ||
      needsReload ||
      isActiveJob(job) ||
      !planCurrent(saved.session, saved.workflow)
    ) {
      setError('Save the current script, sources and shots before requesting a quote.');
      return;
    }
    void run('Requesting the current cost quote', async (signal) => {
      guardDrafts('none');
      const history = await creatorApi.jobs(saved.session.id, signal);
      const existing =
        history.jobs.find(isActiveJob) ??
        history.jobs.find((item) => outputIsCurrent(item, saved.session, saved.workflow));
      if (existing) {
        await showSavedJob(existing, signal);
        return;
      }
      acceptQuote(null);
      const result = await creatorApi.quote(
        saved.session.id,
        {
          expectedVersion: saved.session.version,
          expectedWorkflowVersion: saved.workflow.version,
        },
        signal,
      );
      const latest = await creatorApi.get(saved.session.id, signal);
      accept(latest);
      if (!quoteIsCurrent(result.quote, latest.session, latest.workflow))
        throw new Error(
          'The creation changed while its quote was prepared. Request a fresh quote for the saved version.',
        );
      saveQuote(browserRequestStorage(), result.quote);
      acceptQuote(result.quote);
      acceptBudget(result.budget);
      setNotice(
        'The quote is saved for review. Requesting it has not started paid video generation.',
      );
    });
  }

  async function showSavedJob(candidate: CreatorJob, signal: AbortSignal) {
    const result = await creatorApi.job(candidate.sessionId, candidate.id, signal);
    acceptJob(result);
    accept(await creatorApi.get(candidate.sessionId, signal));
    if (isActiveJob(result.job)) watch(result.job);
    void loadBudget(signal);
    setNotice('Showing the existing generation run. No new quote or paid request was submitted.');
  }

  function approveAndProduce(reviewed: boolean) {
    const saved = current.current;
    const quoted = quoteRef.current;
    if (!saved?.session.plan) return;
    if (
      !reviewed ||
      dirty ||
      needsReload ||
      isActiveJob(job) ||
      !planCurrent(saved.session, saved.workflow)
    ) {
      setError(
        'Save the current work, request a fresh quote, and review its cost before approving generation.',
      );
      return;
    }
    if (generatedSeconds(saved.session.plan.clips) > saved.session.plan.maxGeneratedSeconds) {
      setError(
        'This shot plan exceeds its saved generation budget. Shorten the clips and save again.',
      );
      return;
    }
    if (!quoted) return;
    void run('Reviewing the exact quoted cost', async (signal) => {
      guardDrafts('none');
      const history = await creatorApi.jobs(saved.session.id, signal);
      const existing =
        history.jobs.find(isActiveJob) ??
        history.jobs.find((item) => item.kind === 'production' && item.quoteId === quoted.id);
      // A server receipt wins over stale local prices, expiry and storage after an unknown outcome.
      if (existing) {
        await showSavedJob(existing, signal);
        return;
      }
      if (!capabilities?.configured || !capabilities.visionConfigured)
        throw new Error(
          capabilities?.reason ||
            'Generation and visual audit providers must be configured before paid work starts.',
        );
      const freshBudget = await creatorApi.budget(signal);
      acceptBudget(freshBudget.budget);
      if (!quoteIsAffordable(quoted, freshBudget.budget))
        throw new Error(
          'Other app activity has used part of the available budget. Review the current balance and request a fresh quote.',
        );
      if (!quoteIsCurrent(quoted, current.current!.session, current.current!.workflow))
        throw new Error(
          'This quote expired or the creation changed. Request and review a new quote.',
        );
      const approved =
        approvalCurrent(saved.session, saved.workflow) &&
        saved.session.approval?.quoteId === quoted.id
          ? saved
          : await creatorApi.approve(
              saved.session.id,
              {
                expectedVersion: saved.session.version,
                expectedWorkflowVersion: saved.workflow.version,
                planId: saved.session.plan!.id,
                reviewed: true,
                costReviewed: true,
                quoteId: quoted.id,
              },
              signal,
            );
      accept(approved, true);
      if (!approved.session.approval)
        throw new Error('The server did not return an approval. No generation was started.');
      const approvalId = approved.session.approval.id;
      if (approved.session.approval.quoteId !== quoted.id)
        throw new Error(
          'The saved approval belongs to a different quote. No generation was submitted.',
        );
      const approvedQuote = { ...quoted, approvedApprovalId: approvalId };
      saveQuote(browserRequestStorage(), approvedQuote);
      acceptQuote(approvedQuote);
      setBusy('Checking saved generation activity');
      const latestHistory = await creatorApi.jobs(approved.session.id, signal);
      const known = productionDecision(latestHistory.jobs, approvalId, quoted.id, null);
      if (known.kind === 'reconnect') {
        await showSavedJob(known.job, signal);
        return;
      }
      const storage = browserRequestStorage();
      const remembered = readProductionRequest(storage, approved.session.id, approvalId, quoted.id);
      const decision = productionDecision(latestHistory.jobs, approvalId, quoted.id, remembered);
      if (decision.kind === 'reconnect') {
        await showSavedJob(decision.job, signal);
        return;
      }
      const requestId = decision.requestId ?? crypto.randomUUID();
      saveProductionRequest(storage, approved.session.id, approvalId, quoted.id, requestId);
      if (!quoteIsCurrent(approvedQuote, approved.session, approved.workflow))
        throw new Error(
          'The approved quote expired before submission. No paid request was sent; request a new quote.',
        );
      setBusy('Submitting the approved generation');
      const result = await creatorApi.produce(
        approved.session.id,
        {
          expectedVersion: approved.session.version,
          approvalId,
          quoteId: quoted.id,
          requestId,
        },
        signal,
      );
      acceptJob(result);
      watch(result.job);
      void loadBudget(signal);
    });
  }

  function savePhotoDescription(assetId: string) {
    const saved = current.current;
    const description = photoEdits[assetId];
    if (!saved || typeof description !== 'string') return;
    void run('Saving the photo description', async (signal) => {
      guardDrafts('photo');
      const updated = await promoApi.describeAsset(
        saved.workflow.id,
        assetId,
        saved.workflow.version,
        description.trim(),
        signal,
      );
      accept({ session: saved.session, workflow: updated.workflow });
      setPhotoEdits((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([id]) => id !== assetId)),
      );
      accept(await creatorApi.get(saved.session.id, signal));
      setNotice(
        'Photo description saved. Prepare a new proposal and cost quote for the changed source.',
      );
    });
  }

  function removePhoto(assetId: string) {
    const saved = current.current;
    if (!saved || !saved.workflow.assets.some((asset) => asset.id === assetId)) return;
    void run('Removing the photo', async (signal) => {
      guardDrafts('none');
      const updated = await promoApi.removeAsset(
        saved.workflow.id,
        assetId,
        saved.workflow.version,
        signal,
      );
      accept({ session: saved.session, workflow: updated.workflow });
      accept(await creatorApi.get(saved.session.id, signal));
      setNotice('Photo removed. Prepare the current film and a new quote before generation.');
    });
  }

  function saveSavedAnswers() {
    const saved = current.current;
    if (!saved || !answersDirty) return;
    void run('Saving corrected direction', async (signal) => {
      guardDrafts('answers');
      const answers = saved.session.answers.map((answer) => ({
        ...answer,
        answer: answerEdits[answer.questionId]?.trim() ?? answer.answer,
      }));
      if (answers.some((answer) => !answer.answer))
        throw new Error(
          'Keep an answer for each saved question, or replace it with your corrected direction.',
        );
      accept(
        await creatorApi.patch(
          saved.session.id,
          { expectedVersion: saved.session.version, answers },
          signal,
        ),
        true,
      );
      setNotice(
        'Your corrected answers are saved. Prepare the proposal again before approving generation.',
      );
    });
  }

  function cancel() {
    if (!job || !isActiveJob(job)) return;
    void run('Canceling remaining work', async (signal) => {
      const result = await creatorApi.cancel(job.sessionId, job.id, signal);
      acceptJob(result);
      if (!isActiveJob(result.job)) {
        poll.current?.abort();
        setWatching(false);
      }
      setNotice(
        'Cancellation requested. In flight provider work may continue and may still be billed.',
      );
    });
  }

  return {
    state,
    capabilities,
    capabilityError,
    quote,
    budget,
    budgetError,
    requestQuote,
    source,
    setSource,
    photos,
    setPhotos,
    addPhotos,
    photoEdits,
    setPhotoEdits,
    photoEditsDirty,
    savePhotoDescription,
    removePhoto,
    plan,
    setPlan,
    script,
    setScript,
    reply,
    setReply,
    replyQuestion,
    writeReply: (question: CreatorQuestion, value: string) => {
      if (!reply.trim()) setReplyQuestion(question);
      setReply(value);
      if (!value.trim()) setReplyQuestion(null);
    },
    answerEdits,
    setAnswerEdits,
    answersDirty,
    saveSavedAnswers,
    externalReferences: state?.session.externalReferences ?? externalReferences,
    selectExternal,
    saveExternalReference,
    removeExternal,
    job,
    watching,
    loading,
    busy,
    error,
    notice,
    needsReload,
    dirty,
    inputDirty,
    planDirty,
    scriptDirty,
    create,
    saveSources,
    answer,
    selectReference,
    analyze,
    prepare,
    savePlan,
    saveScript,
    approveAndProduce,
    cancel,
    reload: () => setReloadKey((value) => value + 1),
    useSaved: () => {
      if (current.current) {
        accept(current.current, true);
        setNotice('Showing the saved draft.');
      }
    },
    clearError: () => setError(''),
    reconnect: () => {
      if (job) watch(job);
    },
    stopWatching: () => {
      poll.current?.abort();
      setWatching(false);
      setNotice('Status checks paused. Server work continues.');
    },
  };
}

export type CreatorController = ReturnType<typeof useCreatorSession>;
