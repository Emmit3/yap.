import { useEffect, useRef, useState } from 'react';
import type {
  SocialInvestigation,
  SocialResearchRun,
  SocialResearchRunInput,
} from '@yap/contracts/social';
import { ResearchApiError, researchError, socialApi } from './api';

const savedRunKey = 'yap-active-research-run';
const terminal = (run: SocialResearchRun) =>
  ['completed', 'failed', 'canceled'].includes(run.status);
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Canceled'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Canceled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 750);
    signal.addEventListener('abort', abort, { once: true });
  });
function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(savedRunKey, id);
    else sessionStorage.removeItem(savedRunKey);
  } catch {
    /* In-memory activity remains usable. */
  }
}

export function useResearchRun(callbacks: {
  onComplete(investigation: SocialInvestigation, run: SocialResearchRun): void;
  onBusy(value: boolean): void;
  onError(message: string): void;
}) {
  const [run, setRun] = useState<SocialResearchRun | null>(null);
  const [connected, setConnected] = useState(true);
  const [resultLoaded, setResultLoaded] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const mounted = useRef(false);
  const knownId = useRef<string | null>(null);
  const cancelingId = useRef<string | null>(null);

  async function follow(initial: SocialResearchRun, signal: AbortSignal) {
    let snapshot = initial;
    while (!signal.aborted) {
      if (!mounted.current) return;
      setRun(snapshot);
      if (terminal(snapshot)) {
        if (snapshot.status === 'completed' && snapshot.investigationId) {
          const result = await socialApi.get(snapshot.investigationId, signal);
          if (signal.aborted || !mounted.current) return;
          setResultLoaded(true);
          latest.current.onComplete(result.investigation, snapshot);
        } else if (snapshot.status === 'failed') {
          latest.current.onError(
            snapshot.error?.message ??
              'This research run could not finish. Review the source activity and try again.',
          );
        }
        remember(null);
        return;
      }
      await pause(signal);
      snapshot = (await socialApi.getRun(snapshot.id, signal)).run;
    }
  }

  async function watch(id: string) {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    knownId.current = id;
    setResultLoaded(false);
    latest.current.onBusy(true);
    setConnected(true);
    try {
      const snapshot = (await socialApi.getRun(id, current.signal)).run;
      await follow(snapshot, current.signal);
    } catch (error) {
      if (error instanceof ResearchApiError && error.status === 404) {
        remember(null);
        knownId.current = null;
        if (mounted.current) setRun(null);
      }
      if (!current.signal.aborted && mounted.current) {
        setConnected(false);
        latest.current.onError(researchError(error));
      }
    } finally {
      if (controller.current === current) {
        controller.current = null;
        if (mounted.current) latest.current.onBusy(false);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(savedRunKey);
    } catch {
      /* Storage is optional. */
    }
    if (saved && /^[a-f0-9-]{36}$/i.test(saved)) void watch(saved);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      controller.current = null;
    };
  }, []);

  async function start(input: SocialResearchRunInput) {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    latest.current.onBusy(true);
    setConnected(true);
    setRun(null);
    setResultLoaded(false);
    try {
      const snapshot = (await socialApi.startRun(input, current.signal)).run;
      knownId.current = snapshot.id;
      remember(snapshot.id);
      await follow(snapshot, current.signal);
    } catch (error) {
      if (!current.signal.aborted && mounted.current) {
        setConnected(false);
        latest.current.onError(researchError(error));
      }
    } finally {
      if (controller.current === current) {
        controller.current = null;
        if (mounted.current) latest.current.onBusy(false);
      }
    }
  }

  async function cancel() {
    const id = knownId.current;
    const activeController = controller.current;
    if (!id || cancelingId.current === id) return;
    cancelingId.current = id;
    try {
      const result = await socialApi.cancelRun(id);
      if (!mounted.current || knownId.current !== id || controller.current !== activeController)
        return;
      setRun(result.run);
      setConnected(true);
      if (terminal(result.run)) {
        remember(null);
        activeController?.abort();
        controller.current = null;
        if (mounted.current) latest.current.onBusy(false);
      }
    } catch (error) {
      if (mounted.current && knownId.current === id) latest.current.onError(researchError(error));
    } finally {
      if (cancelingId.current === id) cancelingId.current = null;
    }
  }

  return {
    run,
    connected,
    resultLoaded,
    start,
    cancel,
    reconnect: () => {
      if (knownId.current) void watch(knownId.current);
    },
    dismiss: () => {
      if (run && terminal(run)) {
        setRun(null);
        knownId.current = null;
        remember(null);
      }
    },
  };
}
