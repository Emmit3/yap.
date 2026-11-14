import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Pause, Play } from '@phosphor-icons/react';
import type { PosterStyle } from '@yap/contracts/posters';
import { posterApi } from './api';
import { observePosterPointerRelease } from './poster-pointer-lifecycle';
import {
  posterCarouselLayout,
  posterCarouselPose,
  posterFocusOffset,
  posterIndex,
  posterInitialIndex,
  posterTransform,
  posterWallCell,
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
  const ambient = useRef(0);
  const pan = useRef(0);
  const targetPan = useRef(0);
  const rows = useRef<number[]>([]);
  const targetRows = useRef<number[]>([]);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const requestDraw = useRef<() => void>(noFrame);
  const paintImmediately = useRef<() => void>(noFrame);
  const suppressClick = useRef(false);
  const clickReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initial = posterInitialIndex(styles.length, 1000);
  const selectedIndex = useRef(initial);
  const [current, setCurrent] = useState(initial);
  const [inspected, setInspected] = useState<number | null>(null);
  const [bounds, setBounds] = useState({ width: 1000, height: 640 });
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
  const titleId = useId(),
    helpId = useId();
  const hasStyles = styles.length > 0;
  const layout = posterCarouselLayout(bounds.width, bounds.height, styles.length);
  const canFloat = layout.columns > 1;
  const automatic =
    active &&
    onScreen &&
    documentVisible &&
    !reduced &&
    !paused &&
    !hovered &&
    !focused &&
    !dragging &&
    canFloat;

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setBounds((old) =>
          old.width === rect.width && old.height === rect.height
            ? old
            : { width: rect.width, height: rect.height },
        );
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
    ambient.current = 0;
    pan.current = 0;
    targetPan.current = 0;
    const pointer = drag.current;
    drag.current = null;
    if (pointer && stage.current?.hasPointerCapture(pointer.pointerId))
      stage.current.releasePointerCapture(pointer.pointerId);
    selectedIndex.current = posterInitialIndex(
      stylesRef.current.length,
      bounds.width,
      bounds.height,
    );
    setCurrent(selectedIndex.current);
    setInspected(null);
    setDragging(false);
    setAnnouncement('');
  }, [catalog, bounds.width, bounds.height]);

  useEffect(() => {
    rows.current = Array(layout.rows).fill(0);
    const focus = posterFocusOffset(
      selectedIndex.current,
      ambient.current,
      stylesRef.current.length,
      bounds.width,
      bounds.height,
      pan.current,
    );
    if (layout.rows) rows.current[focus.row] = focus.offset;
    targetRows.current = [...rows.current];
  }, [catalog, bounds.width, bounds.height, layout.rows]);

  useEffect(() => {
    if (active) return;
    const pointer = drag.current;
    drag.current = null;
    if (pointer && stage.current?.hasPointerCapture(pointer.pointerId))
      stage.current.releasePointerCapture(pointer.pointerId);
    setDragging(false);
    setHovered(false);
    setFocused(false);
    setInspected(null);
  }, [active]);

  useEffect(() => {
    let alive = true,
      lastTime = 0;
    const canMove = active && onScreen && documentVisible;
    const paint = () => {
      const items = stylesRef.current;
      const poses = items.map((_, index) =>
        posterCarouselPose(
          index,
          ambient.current,
          items.length,
          bounds.width,
          bounds.height,
          pan.current,
          rows.current,
        ),
      );
      let anchor = selectedIndex.current;
      if (!poses[anchor]?.visible) {
        let nearest = Infinity;
        poses.forEach((pose, index) => {
          const distance = Math.abs(pose.projectedX) + Math.abs(pose.projectedY) * 0.65;
          if (pose.visible && distance < nearest) {
            nearest = distance;
            anchor = index;
          }
        });
      }
      items.forEach((style, index) => {
        const node = cards.current.get(style.id),
          pose = poses[index]!;
        if (!node) return;
        node.style.transform = posterTransform(pose);
        node.style.opacity = String(pose.opacity);
        node.style.zIndex = String(pose.zIndex);
        node.style.visibility = pose.visible ? 'visible' : 'hidden';
        node.style.pointerEvents = active && pose.visible ? 'auto' : 'none';
        node.tabIndex = active && index === anchor ? 0 : -1;
        node.inert = !active || !pose.visible;
        node.setAttribute('aria-hidden', String(!active || !pose.visible));
      });
    };
    const schedule = () => {
      if (alive && canMove && !frame.current) frame.current = requestAnimationFrame(draw);
    };
    const draw = (time: number) => {
      frame.current = 0;
      if (!alive || !canMove) return;
      const elapsed = Math.min(lastTime ? time - lastTime : 16, 64);
      lastTime = time;
      if (automatic) ambient.current += elapsed * 0.016;
      if (drag.current?.horizontal) pan.current = targetPan.current = drag.current.position;
      else {
        pan.current +=
          (targetPan.current - pan.current) * (reduced ? 1 : 1 - Math.exp(-elapsed / 160));
        if (Math.abs(targetPan.current - pan.current) < 0.1) pan.current = targetPan.current;
      }
      let rowMoving = false;
      targetRows.current.forEach((target, row) => {
        const current = rows.current[row] ?? 0;
        rows.current[row] = reduced
          ? target
          : current + (target - current) * (1 - Math.exp(-elapsed / 160));
        if (Math.abs(target - rows.current[row]!) < 0.1) rows.current[row] = target;
        else rowMoving = true;
      });
      paint();
      if (automatic || drag.current?.horizontal || pan.current !== targetPan.current || rowMoving)
        schedule();
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
  }, [active, automatic, catalog, documentVisible, onScreen, reduced, bounds.width, bounds.height]);

  function navigate(next: number, instant = false, moveFocus = false) {
    if (!active || !styles.length) return;
    targetPan.current = pan.current;
    const index = posterIndex(next, styles.length);
    selectedIndex.current = index;
    setCurrent(index);
    setInspected(null);
    const row = posterWallCell(index, layout).row;
    const destination = posterFocusOffset(
      index,
      ambient.current,
      styles.length,
      bounds.width,
      bounds.height,
      pan.current,
      rows.current[row] ?? 0,
    );
    targetRows.current[destination.row] = destination.offset;
    if (instant || reduced) {
      rows.current[destination.row] = destination.offset;
      paintImmediately.current();
    }
    requestDraw.current();
    setAnnouncement(`${styles[index]!.title}. ${index + 1} of ${styles.length}.`);
    if (moveFocus) cards.current.get(styles[index]!.id)?.focus({ preventScroll: true });
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || styles.length < 2) return;
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = selectedIndex.current + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = selectedIndex.current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = styles.length - 1;
    else return;
    event.preventDefault();
    navigate(next, true, true);
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!active || !canFloat || !event.isPrimary || event.button > 0 || drag.current) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: pan.current,
      position: pan.current,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      horizontal: false,
    };
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const pointer = drag.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const dx = event.clientX - pointer.startX,
      dy = event.clientY - pointer.startY;
    if (!pointer.horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      pointer.horizontal = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    if (!pointer.horizontal) return;
    event.preventDefault();
    const velocity =
      (event.clientX - pointer.lastX) / Math.max(1, event.timeStamp - pointer.lastTime);
    pointer.velocity += (velocity - pointer.velocity) * 0.45;
    pointer.position = pointer.startPosition + dx;
    pointer.lastX = event.clientX;
    pointer.lastTime = event.timeStamp;
    requestDraw.current();
  }
  function finishPointer(pointerId: number | null, timeStamp: number, cancelled: boolean) {
    const pointer = drag.current;
    if (!pointer || (pointerId !== null && pointer.pointerId !== pointerId)) return;
    drag.current = null;
    if (pointer.horizontal) {
      const velocity =
        !cancelled && !reduced && timeStamp - pointer.lastTime < 100 ? pointer.velocity : 0;
      pan.current = pointer.position;
      targetPan.current =
        pointer.position + clamp(velocity * 160, -layout.spacing * 1.2, layout.spacing * 1.2);
      if (reduced) pan.current = targetPan.current;
      suppressClick.current = true;
      if (clickReset.current !== undefined) clearTimeout(clickReset.current);
      clickReset.current = setTimeout(() => {
        suppressClick.current = false;
      }, 0);
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
  }, [hasStyles, catalog, reduced, layout.spacing]);

  const selected = styles[posterIndex(inspected ?? current, styles.length)];
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
        <h2 id={titleId}>Poster collection</h2>
        <p id={helpId}>Drift through the collection. Choose a poster to make it yours.</p>
        <span className="poster-carousel-total">{styles.length} looks</span>
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
            onPointerLeave={() => {
              setHovered(false);
              setInspected(null);
            }}
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
              const pose = posterCarouselPose(
                index,
                ambient.current,
                styles.length,
                bounds.width,
                bounds.height,
                pan.current,
                rows.current,
              );
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
                  style={{
                    width: layout.cardWidth,
                    height: layout.cardHeight,
                    transform: posterTransform(pose),
                    opacity: pose.opacity,
                    zIndex: pose.zIndex,
                    visibility: pose.visible ? 'visible' : 'hidden',
                  }}
                  onPointerEnter={() => setInspected(index)}
                  onFocus={() => {
                    selectedIndex.current = index;
                    setCurrent(index);
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
            <p className="poster-carousel-caption">{selected?.title}</p>
            <div className="poster-carousel-controls" aria-label="Poster collection controls">
              <button
                className="poster-carousel-motion"
                type="button"
                disabled={!active || !canFloat || reduced}
                aria-label={
                  reduced
                    ? 'Floating is off for reduced motion'
                    : paused
                      ? 'Resume floating'
                      : 'Pause floating'
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
                onClick={() => navigate(selectedIndex.current - 1)}
              >
                <ArrowLeft size={20} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="poster-carousel-arrow"
                disabled={!active || styles.length < 2}
                aria-label="Next poster"
                onClick={() => navigate(selectedIndex.current + 1)}
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
