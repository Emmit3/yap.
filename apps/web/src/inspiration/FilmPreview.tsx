import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { publicMediaUrl, type ClipPreview } from './catalog';
import { filmPlaybackUrl, observeFilmPlayback } from './preview-playback';

export interface FilmPreviewProps {
  clip: ClipPreview;
  active: boolean;
  label: string;
  preview?: boolean;
}

/** Inactive previews render no player; the gallery keeps its verified thumbnail underneath. */
export function FilmPreview({ clip, active, label, preview = true }: FilmPreviewProps) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [failedSource, setFailedSource] = useState('');
  const [blockedSource, setBlockedSource] = useState('');
  const [readySource, setReadySource] = useState('');
  const url = filmPlaybackUrl(clip, preview);
  const session = useRef({ active, url, preview, revision: 0 });
  if (
    session.current.active !== active ||
    session.current.url !== url ||
    session.current.preview !== preview
  )
    session.current = { active, url, preview, revision: session.current.revision + 1 };
  const identity = `${clip.kind}:${preview}:${url ?? ''}:${session.current.revision}`;
  const failed = failedSource === identity;
  const ready = readySource === identity;
  useEffect(() => {
    if (!active || !preview || !url || failed || clip.kind !== 'embed' || !frame.current) return;
    return observeFilmPlayback(frame.current, url, (state) => {
      if (state === 'error') setFailedSource(identity);
      else setReadySource(state === 'playing' ? identity : '');
    });
  }, [active, preview, url, failed, clip.kind, identity]);
  useEffect(() => {
    if (!active || !preview || !url || failed || ready) return;
    const deadline = setTimeout(() => setFailedSource(identity), 15_000);
    return () => clearTimeout(deadline);
  }, [active, preview, url, failed, ready, identity]);
  useEffect(() => {
    const node = video.current;
    if (!active || !url || failed || clip.kind !== 'video' || !node) return;
    let cancelled = false;
    node.defaultMuted = true;
    node.muted = true;
    if (node.getAttribute('src') !== url) node.setAttribute('src', url);
    void node.play().catch(() => {
      if (cancelled) return;
      if (preview) setFailedSource(identity);
      else setBlockedSource(identity);
    });
    return () => {
      cancelled = true;
      node.pause();
      node.removeAttribute('src');
      node.load();
    };
  }, [active, url, failed, clip.kind, preview, identity]);
  if (!active || !url || failed) return null;
  const style: CSSProperties = {
    display: 'block',
    width: '100%',
    height: '100%',
    border: 0,
    objectFit: preview ? 'cover' : 'contain',
    opacity: !preview || ready ? 1 : 0,
    ...(preview ? { position: 'absolute', inset: 0, pointerEvents: 'none' } : {}),
  };
  const shared = {
    className: 'film-preview-media',
    style,
    tabIndex: preview ? -1 : 0,
    'aria-hidden': preview || undefined,
    'data-preview': preview,
    'data-playback-ready': !preview || ready,
  };
  return clip.kind === 'video' ? (
    <video
      key={identity}
      {...shared}
      ref={video}
      src={url}
      poster={publicMediaUrl(clip.poster) ?? undefined}
      autoPlay
      muted
      playsInline
      loop={preview}
      controls={!preview}
      preload={preview ? 'none' : 'metadata'}
      aria-label={preview ? undefined : label}
      data-autoplay-blocked={blockedSource === identity || undefined}
      onError={() => setFailedSource(identity)}
      onPlaying={() => setReadySource(identity)}
      onWaiting={() => setReadySource('')}
    />
  ) : (
    <iframe
      key={identity}
      {...shared}
      ref={frame}
      src={url}
      title={label}
      allow={
        preview
          ? 'autoplay; encrypted-media'
          : 'autoplay; fullscreen; picture-in-picture; encrypted-media'
      }
      allowFullScreen={!preview}
      referrerPolicy="strict-origin-when-cross-origin"
      onError={() => setFailedSource(identity)}
    />
  );
}
