import {
  clamp,
  lerp,
  phase,
  sceneState,
  tilePose,
  loadPose,
  wallLayout,
  wallCell,
} from './motion.js';
import { uniqueReels, reelSelection } from './catalog.js';
import {
  reelId,
  readReelPreferences,
  writeReelPreferences,
  toggleReelPreference,
  readSharedReelId,
  reelShareUrl,
  restoreSharedReel,
} from './reel-actions.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const embedded =
  new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
let outerUrl;
if (embedded) {
  try {
    outerUrl = window.parent.location.href;
  } catch {
    /* A standalone link remains available. */
  }
}
let preferenceStorage;
try {
  preferenceStorage = window.localStorage;
} catch {
  /* Personal choices remain available for this visit. */
}
function requestWorkspace(type) {
  if (!embedded) return false;
  window.parent.postMessage({ type }, location.origin);
  return true;
}
const experience = $('.experience');
const stage = $('.experience-stage');
const wall = $('#wall');
const intro = $('.intro-layer');
const product = $('.product-layer');
const phone = $('.phone-anchor');
const rail = $('.reel-rail-ui');
const video = $('#reel-video');
const poster = $('#phone-poster');
const film = $('#film-dialog');
const filmVideo = $('#film-video');
// The selected entry owns its media; HTML sample sources must not leak into still previews.
video.querySelectorAll('source').forEach((source) => source.remove());
filmVideo.querySelectorAll('source').forEach((source) => source.remove());
const studio = $('#studio-dialog');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const headlineLines = $$('.intro-line > span');
const introKicker = $('.intro-kicker');
const introCaption = $('.intro-caption');
const introScroll = $('.intro-scroll');
const siteHead = $('.site-head');
const fallbackReels = [
  {
    file: 'fashion',
    title: 'A little louder',
    category: 'EDITORIAL',
    screen: 'Wear the\nwhole feeling.',
    caption: 'For the days that deserve a little more color.',
  },
  {
    file: 'coast',
    title: 'Somewhere slower',
    category: 'ESCAPE',
    screen: 'Take the\nlong way home.',
    caption: 'A small detour. A whole different feeling.',
  },
  {
    file: 'ocean',
    title: 'Blue, for a while',
    category: 'NATURE STUDY',
    screen: 'Nothing but\nthe blue.',
    caption: 'A little space to let your mind wander.',
  },
  {
    file: 'forest',
    title: 'Off the map',
    category: 'THE OUTSIDE',
    screen: 'Go where\nit gets quiet.',
    caption: 'No notifications. Just a different kind of signal.',
  },
  {
    file: 'mountains',
    title: 'Higher ground',
    category: 'ESCAPE',
    screen: 'A little\nperspective.',
    caption: 'Some thoughts need a little room to grow.',
  },
  {
    file: 'cosmos',
    title: 'What if, forever',
    category: 'DAYDREAM',
    screen: 'Small thought.\nBig universe.',
    caption: 'The best ideas start somewhere out there.',
  },
  {
    file: 'skyline',
    title: 'A different angle',
    category: 'CITY STUDY',
    screen: 'Look at it\none more time.',
    caption: 'Something familiar. A whole new way of seeing it.',
  },
  {
    file: 'desert',
    title: 'Nothing, beautifully',
    category: 'STILLNESS',
    screen: 'Less noise.\nMore feeling.',
    caption: 'For the thoughts that need a little silence.',
  },
  {
    file: 'portrait',
    title: 'Main character',
    category: 'PORTRAIT',
    screen: 'Your kind\nof cinematic.',
    caption: 'There is a whole story in a single look.',
  },
  {
    file: 'green',
    title: 'Before the world wakes',
    category: 'FIRST LIGHT',
    screen: 'Stay for\nthe first light.',
    caption: 'A beginning worth getting up for.',
  },
  {
    file: 'night',
    title: 'After hours',
    category: 'CITY STUDY',
    screen: 'The city\nis still awake.',
    caption: 'Some ideas come alive after dark.',
    video: true,
  },
  {
    file: 'city',
    title: 'Everyday, differently',
    category: 'STREET STORIES',
    screen: 'Find the story\non your street.',
    caption: 'A little love letter to the places we pass.',
  },
];

const media = await fetch('./wall-media.json')
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null);
const catalog = uniqueReels(media?.clips, import.meta.url);
const availableReels = catalog.length
  ? catalog
  : uniqueReels(
      fallbackReels.map((reel) => ({
        ...reel,
        poster: `./media/reel-${reel.file}.jpg`,
        video: reel.video ? './media/reel-demo.mp4' : null,
      })),
      import.meta.url,
    );
const sharedReel = restoreSharedReel(availableReels, readSharedReelId(location.href, outerUrl));
const reels = sharedReel.reels;
let preferences = readReelPreferences(preferenceStorage, reels);

let reduced = motionPreference.matches;
let width = innerWidth;
let height = innerHeight;
let travel = 1;
let sceneTop = 0;
let layout = wallLayout(width, height, reels.length);
let count = layout.count;
let selected = sharedReel.index >= 0 ? sharedReel.index : Math.floor(count / 2);
let selectedSmooth = selected;
let progress = reduced ? 1 : 0;
let targetProgress = progress;
let sceneVisible = true;
let frameId = 0;
let lastTime = 0;
let ambient = 0;
let playbackPaused = reduced;
let hasVideoFrame = false;
let phonePlayToken = 0;
let changeTimer;
let toastTimer;
let shareDialog = null;
let displayedReel = null;
let settled = false;
let customIdea = '';
let tiles = [];
let wallVideos = [];
let lastVideoSync = -Infinity;
let dragStart = null;
let dragged = false;
let currentStep = 0;

function buildWall() {
  wallVideos.forEach((entry) => {
    entry.active = false;
    entry.node.pause();
    entry.node.removeAttribute('src');
    entry.node.load();
  });
  wallVideos = [];
  count = layout.count;
  selected = clamp(selected, 0, count - 1);
  selectedSmooth = selected;
  wall.replaceChildren();
  tiles = Array.from({ length: count }, (_, index) => {
    const reel = reels[index];
    const button = document.createElement('button');
    button.className = 'reel-plane';
    button.setAttribute('aria-label', `Preview ${reel.title}`);
    button.setAttribute('aria-pressed', String(index === selected));
    button.tabIndex = -1;
    const image = document.createElement('img');
    image.src = reel.poster;
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    const name = document.createElement('span');
    name.className = 'plane-name';
    name.textContent = reel.title;
    button.append(image, name);
    if (reel.video) {
      const clip = document.createElement('video');
      clip.className = 'wall-video';
      clip.muted = true;
      clip.defaultMuted = true;
      clip.loop = true;
      clip.playsInline = true;
      clip.autoplay = true;
      clip.preload = 'none';
      clip.setAttribute('muted', '');
      clip.setAttribute('playsinline', '');
      clip.setAttribute('aria-hidden', 'true');
      clip.poster = reel.poster;
      const entry = {
        node: clip,
        tile: button,
        src: reel.video,
        index,
        row: wallCell(index, layout).row,
        active: false,
        failed: false,
        visible: false,
        score: 0,
      };
      clip.addEventListener('play', () => {
        if (!entry.active) clip.pause();
      });
      clip.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(clip.duration) && clip.duration > 0)
          clip.currentTime = (index * 0.67) % clip.duration;
      });
      clip.addEventListener('error', () => {
        entry.failed = true;
        entry.active = false;
        button.classList.remove('is-playing');
      });
      button.insertBefore(clip, name);
      button.wallMedia = entry;
      wallVideos.push(entry);
    }
    button.addEventListener('click', () => {
      if (!dragged && settled) selectReel(index);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        selectReel(selected + (event.key === 'ArrowRight' ? 1 : -1), true);
      }
    });
    wall.append(button);
    return button;
  });
}

function measure() {
  const oldCount = layout.count;
  width = innerWidth;
  height = stage.clientHeight;
  layout = wallLayout(width, height, reels.length);
  sceneTop = experience.offsetTop;
  travel = Math.max(1, experience.offsetHeight - height);
  wall.style.perspective = `${layout.perspective}px`;
  if (oldCount !== layout.count) {
    buildWall();
    updateReel(false);
  }
  tiles.forEach((tile, index) => {
    const pose = tilePose(index, selected, progress, width, height, 0, reels.length);
    tile.style.width = `${pose.width}px`;
    tile.style.height = `${pose.height}px`;
  });
  readScroll();
  lastVideoSync = -Infinity;
  requestFrame();
}

function readScroll() {
  targetProgress = reduced ? 1 : clamp((scrollY - sceneTop) / travel);
  requestFrame();
}

function setVisibility(node, visible) {
  node.inert = !visible;
  node.setAttribute('aria-hidden', String(!visible));
  node.classList.toggle('is-visible', visible);
}

function draw(time) {
  frameId = 0;
  if (document.hidden) return;
  const dt = Math.min(lastTime ? time - lastTime : 16, 64);
  lastTime = time;
  const ease = reduced ? 1 : 1 - Math.exp(-dt / 95);
  progress = lerp(progress, targetProgress, ease);
  if (Math.abs(progress - targetProgress) < 0.0001) progress = targetProgress;
  if (dragStart?.horizontal) selectedSmooth = dragStart.position;
  else {
    selectedSmooth = lerp(selectedSmooth, selected, reduced ? 1 : 1 - Math.exp(-dt / 130));
    if (Math.abs(selectedSmooth - selected) < 0.001) selectedSmooth = selected;
  }
  const movingWall = canPlayWall() && progress < 0.04;
  if (movingWall) ambient += dt * (width < 700 ? 0.022 : 0.036);
  const state = sceneState(progress);
  const elapsed = reduced ? 2 : (time - bootTime) / 1000;
  const entrance = phase(elapsed, 0, 1.6);
  const drift = reduced ? 0 : ambient;
  tiles.forEach((tile, index) => {
    const pose = tilePose(index, selectedSmooth, progress, width, height, drift, reels.length);
    const load = loadPose(
      elapsed,
      index,
      width,
      height,
      Math.max(progress, targetProgress),
      reels.length,
    );
    tile.style.transform = `translate(-50%,-50%) translate3d(${(pose.x + load.x).toFixed(2)}px,${(pose.y + load.y).toFixed(2)}px,${(pose.z + load.z).toFixed(2)}px) rotateX(${load.pitch.toFixed(2)}deg) rotateY(${(pose.yaw + load.yaw).toFixed(2)}deg) rotateZ(${load.roll.toFixed(2)}deg) scale(${(pose.scale * load.scale).toFixed(4)})`;
    tile.style.opacity = String(pose.opacity * load.opacity);
    tile.style.zIndex = String(100 - Math.round(Math.abs(index - selectedSmooth)));
    tile.tabIndex = settled && pose.opacity > 0.5 ? (index === selected ? 0 : -1) : -1;
    tile.style.pointerEvents = settled && pose.opacity > 0.5 ? 'auto' : 'none';
    const entry = tile.wallMedia;
    if (entry) {
      const projection = layout.perspective / (layout.perspective - pose.z - load.z);
      const x = (pose.x + load.x) * projection;
      const y = (pose.y + load.y) * projection;
      const halfW = (pose.width * pose.scale * load.scale * projection) / 2;
      const halfH = (pose.height * pose.scale * load.scale * projection) / 2;
      entry.visible =
        pose.opacity * load.opacity > 0.1 &&
        Math.abs(x) < width / 2 + halfW &&
        Math.abs(y) < height / 2 + halfH &&
        (progress < 0.65 || Math.abs(index - selectedSmooth) <= 1);
      entry.score = Math.abs(x) / width + (Math.abs(y) / height) * 0.15;
    }
  });
  syncWallPlayback(time);
  $('.wall-shade').style.opacity = state.shade;
  intro.style.opacity = String(state.intro);
  intro.style.transform = `translateY(${-phase(progress, 0.02, 0.25) * 48}px)`;
  headlineLines.forEach((line, index) => {
    const reveal = phase(elapsed, 0.26 + index * 0.16, 0.96 + index * 0.2);
    line.style.transform = `translateY(${(1 - reveal) * 115}%) rotateZ(${(1 - reveal) * (index ? -2 : 2)}deg)`;
    line.style.opacity = String(phase(reveal, 0, 0.5));
  });
  const kickerReveal = phase(elapsed, 0.42, 0.95);
  introKicker.style.opacity = String(kickerReveal);
  introKicker.style.transform = `translateY(${(1 - kickerReveal) * 16}px)`;
  const captionReveal = phase(elapsed, 0.8, 1.3);
  introCaption.style.opacity = String(captionReveal);
  introCaption.style.transform = `translateY(${(1 - captionReveal) * 24}px)`;
  const cueReveal = phase(elapsed, 1.05, 1.55);
  introScroll.style.opacity = String(cueReveal);
  introScroll.inert = cueReveal < 0.9;
  const headerReveal = phase(elapsed, 0.45, 1.15);
  siteHead.style.opacity = String(headerReveal);
  siteHead.style.transform = `translateY(${(1 - headerReveal) * -24}px)`;
  siteHead.inert = headerReveal < 0.8;
  intro.inert = state.intro < 0.5;
  intro.setAttribute('aria-hidden', String(state.intro < 0.5));
  product.style.opacity = state.product;
  product.style.transform = `translateY(${(1 - state.product) * 32}px)`;
  setVisibility(product, state.product > 0.8);
  phone.style.opacity = state.device;
  const phoneX = width < 700 ? '-50%' : '-50%';
  phone.style.transform = `translateX(${phoneX}) translateY(${(1 - state.device) * height * 0.21}px) rotateY(${(1 - state.device) * -38}deg) rotateZ(${(1 - state.device) * 8}deg) scale(${lerp(0.72, 1, state.device)})`;
  setVisibility(phone, state.device > 0.9);
  rail.style.opacity = state.rail;
  setVisibility(rail, state.rail > 0.9);
  $('.scene-progress span').style.transform = `scaleY(${progress})`;
  const isSettled = state.rail > 0.92;
  if (settled !== isSettled) {
    settled = isSettled;
    stage.classList.toggle('settled', settled);
    updatePlayback();
  }
  if (movingWall || progress !== targetProgress || selectedSmooth !== selected || entrance < 1)
    requestFrame();
}

function requestFrame() {
  if (!frameId && !document.hidden) frameId = requestAnimationFrame(draw);
}
let bootTime = performance.now();

function canPlayWall() {
  return (
    !reduced &&
    !playbackPaused &&
    sceneVisible &&
    !document.hidden &&
    !film.open &&
    !studio.open &&
    !shareDialog?.open &&
    !opening.open
  );
}

function syncWallPlayback(time = performance.now(), force = false) {
  if (!force && time - lastVideoSync < 250) return;
  lastVideoSync = time;
  const wanted = new Set();
  if (canPlayWall()) {
    const budget = navigator.connection?.saveData ? 2 : width < 700 ? 5 : 8;
    const visible = wallVideos
      .filter((entry) => entry.visible && !entry.failed)
      .sort((a, b) => a.score - b.score);
    for (let row = 0; row < layout.rows; row++) {
      const entry = visible.find((item) => item.row === row);
      if (entry && wanted.size < budget) wanted.add(entry);
    }
    for (const entry of visible) {
      if (wanted.size >= budget) break;
      wanted.add(entry);
    }
  }
  wallVideos.forEach((entry) => {
    const active = wanted.has(entry);
    if (active === entry.active) return;
    entry.active = active;
    if (active) {
      if (!entry.node.getAttribute('src')) entry.node.src = entry.src;
      entry.node
        .play()
        .then(() => {
          if (entry.active) entry.tile.classList.add('is-playing');
          else entry.node.pause();
        })
        .catch((error) => {
          if (error.name === 'AbortError') return;
          entry.failed = true;
          entry.active = false;
          entry.tile.classList.remove('is-playing');
        });
    } else entry.node.pause();
  });
}

function updatePlayback() {
  const data = reelSelection(reels, selected, count).reel;
  const token = ++phonePlayToken;
  const shouldPlay =
    data.video &&
    settled &&
    !playbackPaused &&
    sceneVisible &&
    !document.hidden &&
    !film.open &&
    !studio.open &&
    !shareDialog?.open &&
    !opening.open;
  document.body.classList.toggle(
    'is-paused',
    reduced || playbackPaused || !sceneVisible || document.hidden,
  );
  if (shouldPlay)
    video
      .play()
      .then(() => {
        if (token === phonePlayToken) {
          hasVideoFrame = true;
          video.classList.add('is-playing');
        }
      })
      .catch(() => {
        if (token === phonePlayToken) video.classList.remove('is-playing');
      });
  else video.pause();
  if (!data.video || !hasVideoFrame) video.classList.remove('is-playing');
  $('#toggle-playback').setAttribute('aria-label', playbackPaused ? 'Play reel' : 'Pause reel');
  $('#toggle-playback use').setAttribute('href', playbackPaused ? '#play' : '#pause');
  $('#toggle-wall-motion').setAttribute('aria-pressed', String(playbackPaused));
  $('#toggle-wall-motion .wall-pause-label').textContent = playbackPaused
    ? 'Resume motion'
    : 'Pause motion';
  $('#toggle-wall-motion use').setAttribute('href', playbackPaused ? '#play' : '#pause');
  syncWallPlayback(performance.now(), true);
  requestFrame();
}

function updateReel(animate = true) {
  const selection = reelSelection(reels, selected, count);
  const data = selection.reel;
  const apply = () => {
    displayedReel = data;
    updatePersonalActions(data);
    poster.src = data.poster;
    video.poster = data.poster;
    poster.alt = data.title;
    poster.classList.toggle('is-static', reduced);
    $('#screen-title').textContent = customIdea || data.screen;
    $('#screen-title').style.whiteSpace = customIdea ? 'normal' : 'pre-line';
    $('#reel-caption').textContent = data.caption;
    $('#reel-credit').textContent = data.credit || 'Illustrative sample footage';
    $('.reel-tiny').textContent = customIdea
      ? 'YOUR IDEA · CONCEPT PREVIEW'
      : data.video
        ? 'CREATIVE FILM REFERENCE'
        : 'PHOTO STUDY';
    video.setAttribute(
      'aria-label',
      `${data.video ? 'Film reference' : 'Photo study'}: ${data.title}`,
    );
    $('#active-title').textContent = data.title;
    $('#active-category').textContent = data.category;
    $('#reel-counter').textContent =
      `${String(selection.index + 1).padStart(2, '0')} / ${selection.count}`;
    tiles.forEach((tile, i) => {
      tile.classList.toggle('is-selected', i === selected);
      tile.setAttribute('aria-pressed', String(i === selected));
    });
    $('#previous-reel').disabled = !selection.hasPrevious;
    $('#next-reel').disabled = !selection.hasNext;
    if (data.video && video.getAttribute('src') !== data.video) {
      video.pause();
      video.src = data.video;
      video.load();
    }
    if (data.video) {
      video.currentTime = 0;
      hasVideoFrame = false;
    } else {
      video.pause();
      video.removeAttribute('src');
      video.load();
      hasVideoFrame = false;
    }
    lastVideoSync = -Infinity;
    updatePlayback();
  };
  clearTimeout(changeTimer);
  const device = $('.phone-motion');
  device.classList.remove('is-turning');
  if (animate && !reduced) {
    void device.offsetWidth;
    device.classList.add('is-turning');
    changeTimer = setTimeout(apply, 315);
  } else apply();
}

function selectReel(index, focus = false) {
  const next = clamp(Math.round(index), 0, count - 1);
  if (next === selected) return;
  selected = next;
  customIdea = '';
  updateReel();
  requestFrame();
  if (focus) tiles[selected]?.focus({ preventScroll: true });
}

function goToProduct() {
  window.scrollTo({
    top: reduced ? sceneTop : sceneTop + travel * 0.94,
    behavior: reduced ? 'instant' : 'smooth',
  });
  if (reduced) readScroll();
}

$$('[data-jump]').forEach((button) => button.addEventListener('click', goToProduct));
$('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  goToProduct();
  setTimeout(
    () => {
      $('.product-copy h2').tabIndex = -1;
      $('.product-copy h2').focus({ preventScroll: true });
    },
    reduced ? 0 : 800,
  );
});
$('#previous-reel').addEventListener('click', () => selectReel(selected - 1));
$('#next-reel').addEventListener('click', () => selectReel(selected + 1));
wall.addEventListener('pointerdown', (event) => {
  if (!settled || dragStart || !event.isPrimary || event.button > 0) return;
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    selected,
    position: selected,
    lastX: event.clientX,
    lastTime: event.timeStamp,
    velocity: 0,
    horizontal: false,
    pointerId: event.pointerId,
  };
  dragged = false;
});
wall.addEventListener('pointermove', (event) => {
  if (!dragStart || event.pointerId !== dragStart.pointerId) return;
  const dx = event.clientX - dragStart.x;
  if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(event.clientY - dragStart.y)) {
    if (!dragStart.horizontal) wall.setPointerCapture(event.pointerId);
    dragStart.horizontal = true;
    dragged = true;
    wall.style.cursor = 'grabbing';
  }
  if (dragStart.horizontal) {
    const step = (width < 700 ? 138 : Math.min(236, width * 0.165)) + (width < 700 ? 12 : 20);
    const dt = Math.max(1, event.timeStamp - dragStart.lastTime);
    dragStart.velocity = lerp(dragStart.velocity, (event.clientX - dragStart.lastX) / dt, 0.45);
    dragStart.position = clamp(dragStart.selected - dx / step, 0, count - 1);
    dragStart.lastX = event.clientX;
    dragStart.lastTime = event.timeStamp;
    requestFrame();
  }
});
window.addEventListener('pointerup', (event) => {
  if (!dragStart || event.pointerId !== dragStart.pointerId) return;
  if (dragged) {
    const step = (width < 700 ? 138 : Math.min(236, width * 0.165)) + (width < 700 ? 12 : 20);
    const velocity = event.timeStamp - dragStart.lastTime < 100 ? dragStart.velocity : 0;
    selectReel(dragStart.position - clamp((velocity * 110) / step, -1.4, 1.4));
  }
  if (wall.hasPointerCapture(event.pointerId)) wall.releasePointerCapture(event.pointerId);
  dragStart = null;
  wall.style.cursor = '';
  requestFrame();
  setTimeout(() => {
    dragged = false;
  }, 0);
});
window.addEventListener('pointercancel', (event) => {
  if (dragStart && event.pointerId === dragStart.pointerId) {
    dragStart = null;
    dragged = false;
    wall.style.cursor = '';
    requestFrame();
  }
});

function toggleMotion() {
  playbackPaused = !playbackPaused;
  wallVideos.forEach((entry) => (entry.failed = false));
  updatePlayback();
}
$('#toggle-playback').addEventListener('click', toggleMotion);
$('#toggle-wall-motion').addEventListener('click', toggleMotion);
$('#silent-sample').addEventListener('click', () => showToast('This sample clip is silent.'));
$$('[data-toggle]').forEach((button) =>
  button.addEventListener('click', () => {
    const id = reelId(displayedReel);
    if (!id) return;
    const kind = button.dataset.toggle;
    preferences = toggleReelPreference(preferences, kind, id, reels);
    const persisted = writeReelPreferences(preferenceStorage, preferences, reels);
    updatePersonalActions(displayedReel);
    const active = button.getAttribute('aria-pressed') === 'true';
    showToast(
      `${kind === 'save' ? (active ? 'Reference saved.' : 'Reference removed from saved.') : active ? 'Reference liked.' : 'Like removed.'}${persisted ? ' Kept on this device.' : ' This visit only; browser storage is unavailable.'}`,
    );
  }),
);
function updatePersonalActions(reel) {
  const id = reelId(reel);
  $$('[data-toggle]').forEach((button) => {
    const saved = button.dataset.toggle === 'save';
    const active = preferences[saved ? 'saved' : 'liked'].includes(id);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute(
      'aria-label',
      `${saved ? (active ? 'Unsave' : 'Save') : active ? 'Unlike' : 'Like'} ${reel.title}`,
    );
  });
}
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3000);
}
$('#share-reel').addEventListener('click', async () => {
  const reel = displayedReel;
  const url = reelShareUrl(location.href, reelId(reel), outerUrl);
  if (!url) {
    showToast('A share link is not available for this reference.');
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url);
    showToast('Link to this reference copied.');
  } catch {
    showShareLink(url, reel.title);
  }
});
function showShareLink(url, title) {
  shareDialog?.close();
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog';
  dialog.setAttribute('aria-labelledby', 'share-link-title');
  const form = document.createElement('form');
  form.method = 'dialog';
  const heading = document.createElement('h2');
  heading.id = 'share-link-title';
  heading.textContent = 'Share this reference.';
  const caption = document.createElement('p');
  caption.textContent = title;
  const label = document.createElement('label');
  label.htmlFor = 'share-link-url';
  label.textContent = 'Copy this link to reopen the selected reference';
  const field = document.createElement('textarea');
  field.id = 'share-link-url';
  field.readOnly = true;
  field.value = url;
  field.rows = 3;
  field.addEventListener('focus', () => field.select());
  const close = document.createElement('button');
  close.className = 'primary-button';
  close.type = 'submit';
  close.textContent = 'Done';
  const note = document.createElement('p');
  note.className = 'dialog-note';
  note.textContent =
    'Clipboard access is unavailable. The selected link is ready to copy manually.';
  form.append(heading, caption, label, field, note, close);
  dialog.append(form);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (shareDialog === dialog) shareDialog = null;
    updatePlayback();
    $('#share-reel').focus({ preventScroll: true });
  });
  document.body.append(dialog);
  shareDialog = dialog;
  dialog.showModal();
  field.focus();
  field.select();
  updatePlayback();
}

$$('[data-create-entry]').forEach((button) => {
  button.hidden = !embedded;
});
$$('[data-studio]').forEach((button) =>
  button.addEventListener('click', () => {
    if (requestWorkspace('yap:enter-studio')) return;
    studio.showModal();
    updatePlayback();
    setTimeout(() => $('#idea-input').focus(), 0);
  }),
);
$$('[data-social]').forEach((button) => {
  button.hidden = !embedded;
  button.addEventListener('click', () => requestWorkspace('yap:open-social'));
});
studio.addEventListener('close', updatePlayback);
$$('[data-close-dialog]').forEach((button) =>
  button.addEventListener('click', () => studio.close()),
);
studio.addEventListener('click', (event) => {
  if (event.target === studio) {
    const rect = studio.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      studio.close();
  }
});
$('#idea-input').addEventListener('input', () => {
  $('#idea-count').textContent = `${$('#idea-input').value.length} / 140`;
});
$('#idea-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#idea-input').value.trim();
  if (!input) {
    $('#idea-input').setCustomValidity('Add a little idea to preview.');
    $('#idea-input').reportValidity();
    return;
  }
  $('#idea-input').setCustomValidity('');
  selected = reelSelection(
    reels,
    Number(new FormData(event.currentTarget).get('mood')),
    count,
  ).index;
  selectedSmooth = selected;
  customIdea = input.length > 64 ? `${input.slice(0, 61).trim()}…` : input;
  updateReel(false);
  studio.close();
  goToProduct();
  showToast('Your idea is in the concept preview.');
});
$('#idea-input').addEventListener('input', () => $('#idea-input').setCustomValidity(''));
$('#watch-film').addEventListener('click', () => {
  const data = reelSelection(reels, selected, count).reel;
  filmVideo.pause();
  if (data.video) filmVideo.src = data.video;
  else filmVideo.removeAttribute('src');
  filmVideo.poster = data.poster;
  filmVideo.controls = Boolean(data.video);
  filmVideo.load();
  $('.film-dialog>span').textContent =
    `${data.title} · ${data.video ? 'FILM REFERENCE' : 'IMAGE REFERENCE'}`;
  film.showModal();
  updatePlayback();
  if (data.video) filmVideo.play().catch(() => {});
});
$$('[data-close-film]').forEach((button) => button.addEventListener('click', () => film.close()));
film.addEventListener('close', () => {
  filmVideo.pause();
  updatePlayback();
});
film.addEventListener('click', (event) => {
  if (event.target === film) film.close();
});
function replayWall() {
  window.scrollTo({ top: 0, behavior: 'instant' });
  bootTime = performance.now();
  lastTime = 0;
  ambient = 0;
  lastVideoSync = -Infinity;
  progress = targetProgress = reduced ? 1 : 0;
  stage.tabIndex = -1;
  stage.focus({ preventScroll: true });
  requestFrame();
}
$('#replay-intro').addEventListener('click', replayWall);

const opening = $('#opening-cut');
let openingTimer;
function playOpening() {
  if (reduced) {
    goToProduct();
    showToast('Reduced motion is on. Showing the product directly.');
    return;
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  opening.classList.remove('is-running');
  opening.showModal();
  updatePlayback();
  void opening.offsetWidth;
  opening.classList.add('is-running');
  $('#skip-opening').focus();
  clearTimeout(openingTimer);
  openingTimer = setTimeout(() => opening.close(), 2800);
}
$('#play-opening').addEventListener('click', playOpening);
$('#skip-opening').addEventListener('click', () => opening.close());
opening.addEventListener('close', () => {
  clearTimeout(openingTimer);
  opening.classList.remove('is-running');
  replayWall();
  updatePlayback();
});

function setStep(index, focus = false) {
  currentStep = clamp(index, 0, 2);
  const ids = ['step-idea', 'step-story', 'step-reel'];
  const panels = [$('.idea-demo'), $('.story-demo'), $('.publish-demo')];
  $$('.workflow-step').forEach((button, i) => {
    const active = i === currentStep;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  panels.forEach((panel, i) => (panel.hidden = i !== currentStep));
  $('#workflow-visual').setAttribute('aria-labelledby', ids[currentStep]);
  $('.demo-position').textContent = ['IDEA / 01', 'STORY / 02', 'REEL / 03'][currentStep];
  if (focus) $$('.workflow-step')[currentStep].focus();
}
$$('.workflow-step').forEach((button, i) => {
  button.addEventListener('click', () => setStep(i));
  button.addEventListener('keydown', (event) => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (delta) {
      event.preventDefault();
      setStep((currentStep + delta + 3) % 3, true);
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setStep(event.key === 'Home' ? 0 : 2, true);
    }
  });
});

const revealObserver = new IntersectionObserver(
  (entries) =>
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-revealed');
        revealObserver.unobserve(entry.target);
      }
    }),
  { threshold: 0.15 },
);
$$('.reveal').forEach((element) => revealObserver.observe(element));
const manifesto = $('#manifesto-text');
manifesto.innerHTML = manifesto.innerHTML
  .split(/(<br\s*\/?\s*>|\s+)/)
  .map((token) =>
    token.trim() && !token.startsWith('<br') ? `<span class="word">${token}</span>` : token,
  )
  .join('');
const wordObserver = new IntersectionObserver(
  (entries) =>
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-read');
        wordObserver.unobserve(entry.target);
      }
    }),
  { rootMargin: '0px 0px -15% 0px', threshold: 1 },
);
$$('.manifesto-statement .word').forEach((word, i) => {
  word.style.transitionDelay = `${(i % 6) * 40}ms`;
  wordObserver.observe(word);
});
const sceneObserver = new IntersectionObserver(
  ([entry]) => {
    sceneVisible = entry.isIntersecting;
    updatePlayback();
  },
  { threshold: 0 },
);
sceneObserver.observe(experience);
const workflowObserver = new IntersectionObserver(
  ([entry]) => {
    $('.workflow-visual').classList.toggle('is-paused', !entry.isIntersecting);
  },
  { threshold: 0.1 },
);
workflowObserver.observe($('.workflow-visual'));
window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', measure, { passive: true });
document.addEventListener('visibilitychange', () => {
  lastTime = 0;
  updatePlayback();
  if (!document.hidden) readScroll();
});
motionPreference.addEventListener('change', (event) => {
  reduced = event.matches;
  if (reduced) playbackPaused = true;
  progress = reduced ? 1 : progress;
  measure();
  updateReel(false);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    dragStart = null;
    dragged = false;
  }
});
video.addEventListener('error', () => {
  video.classList.remove('is-playing');
  showToast('Showing the poster while the sample video is unavailable.');
});

buildWall();
measure();
updateReel(false);
setStep(0);
requestFrame();
if (sharedReel.index >= 0 || location.hash === '#product' || location.hash === '#reels')
  requestAnimationFrame(goToProduct);
if (new URLSearchParams(location.search).get('intro') === '1' && !reduced)
  requestAnimationFrame(playOpening);
