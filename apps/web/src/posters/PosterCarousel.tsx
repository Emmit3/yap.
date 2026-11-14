import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Pause, Play } from '@phosphor-icons/react';
import type { PosterStyle } from '@yap/contracts/posters';
import { posterApi } from './api';
import { observePosterPointerRelease } from './poster-pointer-lifecycle';
import {
  posterCarouselLayout,
  posterCarouselPose,
  posterIndex,
  posterTransform,
} from './carousel-motion';
import './poster-carousel.css';

export interface PosterCarouselProps {
  styles: PosterStyle[];
  active: boolean;
  onOpen(style: PosterStyle): void;
}

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  startPosition: number;
  position: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  horizontal: boolean;
};

const noFrame = () => undefined;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function PosterCarousel({ styles, active, onOpen }: PosterCarouselProps) {
  const stage = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const position = useRef(0);
  const target = useRef(0);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const requestDraw = useRef<() => void>(noFrame);
  const paintImmediately = useRef<() => void>(noFrame);
  const suppressClick = useRef(false);
  const clickReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusedIndex = useRef(0);
  const [current, setCurrent] = useState(0);
  const [width, setWidth] = useState(800);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [announcement, setAnnouncement] = useState('');
  const catalog = styles.map((style) => `${style.id}:${style.crop.sha256}`).join('|');
  const catalogRef = useRef(catalog);
  const stylesRef = useRef(styles);
  stylesRef.current = styles;
  const titleId = useId();
  const helpId = useId();
  const hasStyles = styles.length > 0;
  const automatic =
    active &&
    onScreen &&
    documentVisible &&
    !reduced &&
    !paused &&
    !hovered &&
    !focused &&
    !dragging &&
    styles.length > 1;

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => {
      const measured = node.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    const visibility = new IntersectionObserver(
      ([entry]) => setOnScreen(Boolean(entry?.isIntersecting)),
      { threshold: 0.05 },
    );
    visibility.observe(node);
    return () => {
      resize.disconnect();
      visibility.disconnect();
    };
  }, [hasStyles]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changeMotion = () => setReduced(preference.matches);
    const changeVisibility = () => setDocumentVisible(!document.hidden);
    preference.addEventListener('change', changeMotion);
    document.addEventListener('visibilitychange', changeVisibility);
    return () => {
      preference.removeEventListener('change', changeMotion);
      document.removeEventListener('visibilitychange', changeVisibility);
      if (clickReset.current !== undefined) clearTimeout(clickReset.current);
    };
  }, []);

  useEffect(() => {
    if (catalogRef.current === catalog) return;
    catalogRef.current = catalog;
    position.current = 0;
    target.current = 0;
    focusedIndex.current = 0;
    const pointer = drag.current;
    if (pointer && stage.current?.hasPointerCapture(pointer.pointerId))
      stage.current.releasePointerCapture(pointer.pointerId);
    drag.current = null;
    setDragging(false);
    setCurrent(0);
    setAnnouncement('');
  }, [catalog]);

  useEffect(() => {
    if (active) return;
    const node = stage.current;
    const pointer = drag.current;
    if (pointer && node?.hasPointerCapture(pointer.pointerId))
      node.releasePointerCapture(pointer.pointerId);
    drag.current = null;
    setDragging(false);
    setHovered(false);
    setFocused(false);
  }, [active]);

  useEffect(() => {
    let alive = true;
    let lastTime = 0;
    const size = stylesRef.current.length;
    const canMove = active && onScreen && documentVisible;
    const paint = () => {
      const selected = posterIndex(position.current, size);
      for (const [index, style] of stylesRef.current.entries()) {
        const button = cards.current.get(style.id);
        if (!button) continue;
        const pose = posterCarouselPose(index, position.current, size, width);
        button.style.transform = posterTransform(pose);
        button.style.opacity = String(pose.opacity);
        button.style.zIndex = String(pose.zIndex);
        button.style.visibility = pose.visible ? 'visible' : 'hidden';
        button.style.pointerEvents = active && pose.visible ? 'auto' : 'none';
        button.tabIndex = active && index === selected ? 0 : -1;
        button.inert = !active || !pose.visible;
        button.setAttribute('aria-hidden', String(!active || !pose.visible));
        button.dataset.center = String(index === selected);
      }
      if (selected !== focusedIndex.current) {
        focusedIndex.current = selected;
        setCurrent(selected);
      }
    };
    const schedule = () => {
      if (alive && canMove && !frame.current) frame.current = requestAnimationFrame(draw);
    };
    const draw = (time: number) => {
      frame.current = 0;
      if (!alive || !canMove) return;
      const elapsed = Math.min(lastTime ? time - lastTime : 16, 64);
      lastTime = time;
      if (automatic) target.current += elapsed / 18_000;
      if (drag.current?.horizontal) {
        position.current = drag.current.position;
        target.current = drag.current.position;
      } else if (reduced) position.current = target.current;
      else {
        position.current += (target.current - position.current) * (1 - Math.exp(-elapsed / 130));
        if (Math.abs(target.current - position.current) < 0.001) position.current = target.current;
      }
      paint();
      if (automatic || drag.current?.horizontal || position.current !== target.current) schedule();
    };
    requestDraw.current = schedule;
    paintImmediately.current = paint;
    paint();
    schedule();
    return () => {
      alive = false;
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      requestDraw.current = noFrame;
      paintImmediately.current = noFrame;
    };
  }, [active, automatic, catalog, documentVisible, onScreen, reduced, width]);

  function navigate(next: number, instant = false, moveFocus = false) {
    if (!active || !styles.length) return;
    target.current = next;
    if (instant || reduced) {
      position.current = next;
      paintImmediately.current();
    }
    requestDraw.current();
    const index = posterIndex(next, styles.length);
    setAnnouncement(`${styles[index]?.title}. ${index + 1} of ${styles.length}.`);
    if (moveFocus) cards.current.get(styles[index]!.id)?.focus({ preventScroll: true });
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || styles.length < 2) return;
    let next: number;
    if (event.key === 'ArrowRight') next = Math.round(position.current) + 1;
    else if (event.key === 'ArrowLeft') next = Math.round(position.current) - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = styles.length - 1;
    else return;
    event.preventDefault();
    navigate(next, true, true);
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!active || styles.length < 2 || !event.isPrimary || event.button > 0 || drag.current)
      return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: position.current,
      position: position.current,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      horizontal: false,
    };
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointer = drag.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;
    if (!pointer.horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      pointer.horizontal = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    if (!pointer.horizontal) return;
    event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - pointer.lastTime);
    const velocity = (event.clientX - pointer.lastX) / elapsed;
    pointer.velocity += (velocity - pointer.velocity) * 0.45;
    pointer.position = pointer.startPosition - dx / posterCarouselLayout(width).spacing;
    pointer.lastX = event.clientX;
    pointer.lastTime = event.timeStamp;
    requestDraw.current();
  }

  function finishPointer(pointerId: number | null, timeStamp: number, cancelled = false) {
    const pointer = drag.current;
    if (!pointer || (pointerId !== null && pointer.pointerId !== pointerId)) return;
    // Clear before releasing capture: lostpointercapture must not finish the same drag twice.
    drag.current = null;
    if (pointer.horizontal) {
      const velocity = !cancelled && timeStamp - pointer.lastTime < 100 ? pointer.velocity : 0;
      const inertia = clamp((velocity * 110) / posterCarouselLayout(width).spacing, -1.2, 1.2);
      position.current = pointer.position;
      target.current = Math.round(pointer.position - inertia);
      if (reduced) position.current = target.current;
      suppressClick.current = true;
      if (clickReset.current !== undefined) clearTimeout(clickReset.current);
      clickReset.current = setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setAnnouncement(
        `${styles[posterIndex(target.current, styles.length)]?.title}. ${posterIndex(target.current, styles.length) + 1} of ${styles.length}.`,
      );
    }
    const node = stage.current;
    if (node?.hasPointerCapture(pointer.pointerId)) node.releasePointerCapture(pointer.pointerId);
    setDragging(false);
    requestDraw.current();
  }

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    return observePosterPointerRelease(window, node, ({ pointerId, timeStamp, cancelled }) =>
      finishPointer(pointerId, timeStamp, cancelled),
    );
  }, [hasStyles, width, catalog, reduced]);

  const selected = styles[posterIndex(current, styles.length)];
  const layout = posterCarouselLayout(width);
  return (
    <section
      className="poster-carousel"
      role="region"
      aria-roledescription="carousel"
      aria-labelledby={titleId}
      aria-describedby={helpId}
      aria-hidden={!active}
      inert={!active}
      onKeyDown={keyDown}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className="poster-carousel-heading">
        <div>
          <h2 id={titleId}>Find your poster.</h2>
          <p id={helpId}>Drag to explore. Choose a style to make it yours.</p>
        </div>
        <span className="poster-carousel-total">{styles.length} styles</span>
      </div>
      {!styles.length ? (
        <p className="poster-carousel-empty">No posters match this selection.</p>
      ) : (
        <>
          <div
            ref={stage}
            className={`poster-carousel-stage${dragging ? ' is-dragging' : ''}`}
            style={{ perspective: layout.perspective }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onClickCapture={(event) => {
              if (suppressClick.current) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            {styles.map((style, index) => {
              const pose = posterCarouselPose(index, position.current, styles.length, width);
              return (
                <button
                  key={style.id}
                  ref={(node) => {
                    if (node) cards.current.set(style.id, node);
                    else cards.current.delete(style.id);
                  }}
                  type="button"
                  className="poster-carousel-item"
                  aria-label={`Customize ${style.title}`}
                  aria-hidden={!active || !pose.visible}
                  inert={!active || !pose.visible}
                  tabIndex={active && index === posterIndex(current, styles.length) ? 0 : -1}
                  data-center={index === posterIndex(current, styles.length)}
                  style={{
                    width: layout.cardWidth,
                    height: layout.cardHeight,
                    transform: posterTransform(pose),
                    opacity: pose.opacity,
                    zIndex: pose.zIndex,
                    visibility: pose.visible ? 'visible' : 'hidden',
                  }}
                  onClick={() => {
                    if (active && !suppressClick.current) onOpen(style);
                  }}
                >
                  <span className="poster-carousel-art">
                    <img
                      src={posterApi.imageUrl(style.imageUrl)}
                      alt=""
                      draggable={false}
                      decoding="async"
                      width={style.crop.width}
                      height={style.crop.height}
                    />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="poster-carousel-footer">
            <div className="poster-carousel-caption">
              <span>
                {String(posterIndex(current, styles.length) + 1).padStart(2, '0')} /{' '}
                {String(styles.length).padStart(2, '0')}
              </span>
              <p>{selected?.title}</p>
            </div>
            <div className="poster-carousel-controls" aria-label="Poster carousel controls">
              <button
                className="poster-carousel-motion"
                type="button"
                disabled={!active || styles.length < 2 || reduced}
                aria-label={
                  reduced
                    ? 'Rotation is off for reduced motion'
                    : paused
                      ? 'Resume rotation'
                      : 'Pause rotation'
                }
                aria-pressed={paused || reduced}
                onClick={() => setPaused((value) => !value)}
              >
                {paused || reduced ? (
                  <Play size={16} aria-hidden="true" />
                ) : (
                  <Pause size={16} aria-hidden="true" />
                )}
                <span>{reduced ? 'Motion off' : paused ? 'Resume' : 'Pause'}</span>
              </button>
              <button
                type="button"
                className="poster-carousel-arrow"
                disabled={!active || styles.length < 2}
                aria-label="Previous poster"
                onClick={() => navigate(Math.round(position.current) - 1)}
              >
                <ArrowLeft size={20} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="poster-carousel-arrow"
                disabled={!active || styles.length < 2}
                aria-label="Next poster"
                onClick={() => navigate(Math.round(position.current) + 1)}
              >
                <ArrowRight size={20} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
