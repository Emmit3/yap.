/** A visible, quiet home scene. It never advances the opening or changes focus. */
export function mountCinematicHome(root, { onReplay, onActiveChange } = {}) {
  const video = root?.querySelector('.cinematic-home__video');
  if (!video) return () => {};

  const document = root.ownerDocument;
  const window = document.defaultView;
  const pause = root.querySelector('[data-home-pause]');
  const pauseLabel = pause?.querySelector('[data-home-pause-label]');
  const replay = root.querySelector('[data-home-replay]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = window.navigator.connection;
  const removeListeners = [];
  let ratio = 0;
  let userPaused = false;
  let blocked = false;
  let failed = false;
  let pending = false;
  let wanted = false;
  let suspended = false;
  let disposed = false;
  let request = 0;
  let homeActive = false;

  function listen(target, type, callback) {
    target?.addEventListener(type, callback);
    removeListeners.push(() => target?.removeEventListener(type, callback));
  }

  function updateControl() {
    const restricted = motion.matches || Boolean(connection?.saveData);
    const paused = userPaused || blocked || restricted || failed;
    const label = failed
      ? 'Film unavailable'
      : restricted
        ? 'Motion off'
        : paused
          ? 'Play film'
          : 'Pause film';
    pause?.setAttribute('aria-pressed', String(paused));
    pause?.setAttribute('aria-label', label);
    if (pause) pause.disabled = restricted || failed;
    if (pauseLabel && pauseLabel.textContent !== label) pauseLabel.textContent = label;
  }

  function setHomeActive(next) {
    if (homeActive === next) return;
    homeActive = next;
    onActiveChange?.(next);
  }

  function reconcile() {
    if (disposed) return;
    const dialogOpen = Boolean(document.querySelector('dialog[open]'));
    const visible = !document.hidden && !suspended;
    const active = ratio >= 0.55 && visible && !dialogOpen;
    root.dataset.active = String(active);
    const headerFocused = document.querySelector('.site-head')?.contains(document.activeElement);
    setHomeActive(active && ratio >= 0.75 && !headerFocused);

    const next = active && !userPaused && !failed && !motion.matches && !connection?.saveData;
    if (next !== wanted) {
      wanted = next;
      request++;
      pending = false;
      // A new visit can recover suspended autoplay, without polling a failed request.
      if (wanted) blocked = false;
    }
    if (!wanted) video.pause();
    else if (!blocked && !pending && video.paused) {
      const token = ++request;
      pending = true;
      if (!video.getAttribute('src')) video.src = video.dataset.src;
      video.muted = true;
      Promise.resolve()
        .then(() => (disposed || !wanted || token !== request ? undefined : video.play()))
        .then(() => {
          if (disposed || !wanted) video.pause();
        })
        .catch(() => {
          if (!disposed && wanted && token === request) blocked = true;
        })
        .finally(() => {
          if (disposed || token !== request) return;
          pending = false;
          updateControl();
        });
    }
    updateControl();
  }

  listen(pause, 'click', () => {
    if (motion.matches || connection?.saveData || failed) return;
    if (userPaused || blocked) {
      userPaused = false;
      blocked = false;
    } else userPaused = true;
    reconcile();
  });
  listen(replay, 'click', () => onReplay?.());
  listen(video, 'playing', () => {
    if (wanted && !disposed && !failed) root.classList.add('is-playing');
    else video.pause();
  });
  listen(video, 'error', () => {
    failed = true;
    root.classList.remove('is-playing');
    reconcile();
  });
  listen(motion, 'change', reconcile);
  listen(connection, 'change', reconcile);
  listen(document, 'visibilitychange', reconcile);
  listen(document, 'focusin', reconcile);
  listen(document, 'focusout', () => queueMicrotask(reconcile));
  listen(window, 'pagehide', () => {
    suspended = true;
    reconcile();
  });
  listen(window, 'pageshow', () => {
    suspended = false;
    reconcile();
  });

  const observer = new window.IntersectionObserver(
    ([entry]) => {
      ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
      reconcile();
    },
    { threshold: [0, 0.55, 0.75, 1] },
  );
  observer.observe(root);
  const dialogs = new window.MutationObserver(reconcile);
  dialogs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  reconcile();

  return () => {
    if (disposed) return;
    disposed = true;
    wanted = false;
    request++;
    observer.disconnect();
    dialogs.disconnect();
    removeListeners.forEach((remove) => remove());
    video.pause();
    root.classList.remove('is-playing');
    root.dataset.active = 'false';
    setHomeActive(false);
  };
}
