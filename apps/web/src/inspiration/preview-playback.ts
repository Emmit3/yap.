import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { playableClip, publicMediaUrl, type ClipPreview } from './catalog';

/** A chromeless preview URL is separate from the original full-player URL. */
export function filmPlaybackUrl(clip: ClipPreview, preview = true): string | null {
  const safe = publicMediaUrl(clip.src);
  if (!safe) return null;
  const url = new URL(safe);
  if (clip.kind === 'video')
    return playableClip(safe, clip.sourceUrl)?.kind === 'video' ? clip.src : null;
  if (clip.kind !== 'embed') return null;
  const youtube =
    url.hostname === 'www.youtube-nocookie.com' &&
    /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
  const vimeo =
    url.hostname === 'player.vimeo.com' && /^\/video\/([0-9]{3,15})\/?$/.test(url.pathname);
  const mux =
    url.hostname === 'player.mux.com' && /^\/[A-Za-z0-9_-]{16,160}\/?$/.test(url.pathname);
  if (!youtube && !vimeo && !mux) return null;
  if (
    vimeo &&
    url.searchParams.has('h') &&
    !/^[a-f0-9]{10}$/i.test(url.searchParams.get('h') ?? '')
  )
    return null;
  if (!preview) return clip.src;
  if (youtube) {
    const player = new URL(`/embed/${youtube[1]}`, 'https://www.youtube-nocookie.com');
    for (const [name, value] of Object.entries({
      autoplay: '1',
      mute: '1',
      controls: '0',
      loop: '1',
      playlist: youtube[1]!,
      playsinline: '1',
      disablekb: '1',
      rel: '0',
    }))
      player.searchParams.set(name, value);
    return player.href;
  }
  if (vimeo) {
    const player = new URL(url.pathname, 'https://player.vimeo.com');
    const hash = url.searchParams.get('h');
    if (hash) player.searchParams.set('h', hash);
    for (const [name, value] of Object.entries({
      autoplay: '1',
      muted: '1',
      loop: '1',
      controls: '0',
      autopause: '0',
      dnt: '1',
      playsinline: '1',
      title: '0',
      byline: '0',
      portrait: '0',
    }))
      player.searchParams.set(name, value);
    return player.href;
  }
  for (const [name, value] of Object.entries({
    autoplay: 'true',
    muted: 'true',
    loop: 'true',
    controls: 'false',
    playsinline: 'true',
  }))
    url.searchParams.set(name, value);
  return url.href;
}

export interface VisibleClipPreviewOptions {
  ids: string[];
  active: boolean;
  suspended: boolean;
  paused: boolean;
  maxActive?: number;
}

type Environment = { visible: boolean; reducedMotion: boolean };
const environment = (): Environment => ({
  visible: typeof document !== 'undefined' && !document.hidden,
  reducedMotion:
    typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
});

/** Only visible originals acquire players. Crossing a visibility boundary never starts audio. */
export function useVisibleClipPreviews({
  ids,
  active,
  suspended,
  paused,
  maxActive = 6,
}: VisibleClipPreviewOptions) {
  const key = JSON.stringify(ids);
  const ordered = useMemo(() => [...new Set(ids)].slice(0, 300), [key]);
  const maximum = Number.isFinite(maxActive) ? Math.max(0, Math.min(12, Math.floor(maxActive))) : 6;
  const [page, setPage] = useState(environment);
  const enabled = active && !suspended && !paused && page.visible && !page.reducedMotion;
  const observationKey = `${key}:${maximum}:${enabled}`;
  const currentKey = useRef(observationKey);
  currentKey.current = observationKey;
  const known = useRef(new Set(ordered));
  known.current = new Set(ordered);
  const nodes = useRef(new Map<string, HTMLElement>());
  const nodeIds = useRef(new WeakMap<Element, string>());
  const callbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const eligible = useRef(new Set<string>());
  const observer = useRef<IntersectionObserver | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const publish = useRef<() => void>(() => undefined);
  publish.current = () => {
    const next = ordered.filter((id) => eligible.current.has(id)).slice(0, maximum);
    setSnapshot((old) =>
      old.key === observationKey &&
      old.ids.length === next.length &&
      old.ids.every((id, index) => id === next[index])
        ? old
        : { key: observationKey, ids: next },
    );
  };

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPage({ visible: !document.hidden, reducedMotion: preference.matches });
    preference.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      preference.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const refFor = useCallback((id: string) => {
    const existing = callbacks.current.get(id);
    if (existing) return existing;
    const ref = (node: HTMLElement | null) => {
      const previous = nodes.current.get(id);
      if (previous === node) return;
      if (previous) observer.current?.unobserve(previous);
      eligible.current.delete(id);
      if (node) {
        nodes.current.set(id, node);
        nodeIds.current.set(node, id);
        if (known.current.has(id)) observer.current?.observe(node);
      } else nodes.current.delete(id);
      publish.current();
    };
    callbacks.current.set(id, ref);
    return ref;
  }, []);

  useEffect(() => {
    eligible.current.clear();
    for (const id of callbacks.current.keys())
      if (!known.current.has(id)) callbacks.current.delete(id);
    publish.current();
    if (!enabled || !maximum || typeof IntersectionObserver === 'undefined') return;
    let alive = true;
    const watch = new IntersectionObserver(
      (entries) => {
        if (!alive || currentKey.current !== observationKey) return;
        for (const entry of entries) {
          const id = nodeIds.current.get(entry.target);
          if (!id || !known.current.has(id) || nodes.current.get(id) !== entry.target) continue;
          if (!entry.isIntersecting || entry.intersectionRatio < 0.35) eligible.current.delete(id);
          else if (entry.intersectionRatio >= 0.6) eligible.current.add(id);
        }
        publish.current();
      },
      { root: null, threshold: [0, 0.35, 0.6, 1] },
    );
    observer.current = watch;
    for (const [id, node] of nodes.current) if (known.current.has(id)) watch.observe(node);
    return () => {
      alive = false;
      watch.disconnect();
      if (observer.current === watch) observer.current = null;
    };
  }, [observationKey, enabled, maximum]);

  const activeIds = useMemo(
    () => new Set(enabled && snapshot.key === observationKey ? snapshot.ids : []),
    [enabled, observationKey, snapshot],
  );
  return { refFor, activeIds, reducedMotion: page.reducedMotion };
}
