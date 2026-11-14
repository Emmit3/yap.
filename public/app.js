import { clamp, lerp, phase, sceneState, tilePose, loadPose } from './motion.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
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
const studio = $('#studio-dialog');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const headlineLines = $$('.intro-line > span');
const introKicker = $('.intro-kicker');
const introCaption = $('.intro-caption');
const introScroll = $('.intro-scroll');
const siteHead = $('.site-head');
const reels = [
  { file:'fashion', title:'A little louder', category:'EDITORIAL', screen:'Wear the\nwhole feeling.', caption:'For the days that deserve a little more color.' },
  { file:'coast', title:'Somewhere slower', category:'ESCAPE', screen:'Take the\nlong way home.', caption:'A small detour. A whole different feeling.' },
  { file:'ocean', title:'Blue, for a while', category:'NATURE STUDY', screen:'Nothing but\nthe blue.', caption:'A little space to let your mind wander.' },
  { file:'forest', title:'Off the map', category:'THE OUTSIDE', screen:'Go where\nit gets quiet.', caption:'No notifications. Just a different kind of signal.' },
  { file:'mountains', title:'Higher ground', category:'ESCAPE', screen:'A little\nperspective.', caption:'Some thoughts need a little room to grow.' },
  { file:'cosmos', title:'What if, forever', category:'DAYDREAM', screen:'Small thought.\nBig universe.', caption:'The best ideas start somewhere out there.' },
  { file:'skyline', title:'A different angle', category:'CITY STUDY', screen:'Look at it\none more time.', caption:'Something familiar. A whole new way of seeing it.' },
  { file:'desert', title:'Nothing, beautifully', category:'STILLNESS', screen:'Less noise.\nMore feeling.', caption:'For the thoughts that need a little silence.' },
  { file:'portrait', title:'Main character', category:'PORTRAIT', screen:'Your kind\nof cinematic.', caption:'There is a whole story in a single look.' },
  { file:'green', title:'Before the world wakes', category:'FIRST LIGHT', screen:'Stay for\nthe first light.', caption:'A beginning worth getting up for.' },
  { file:'night', title:'After hours', category:'CITY STUDY', screen:'The city\nis still awake.', caption:'Some ideas come alive after dark.', video:true },
  { file:'city', title:'Everyday, differently', category:'STREET STORIES', screen:'Find the story\non your street.', caption:'A little love letter to the places we pass.' },
];

let reduced = motionPreference.matches;
let width = innerWidth;
let height = innerHeight;
let travel = 1;
let sceneTop = 0;
let count = width < 700 ? 15 : 21;
let selected = Math.min(10, count - 1);
let selectedSmooth = selected;
let progress = reduced ? 1 : 0;
let targetProgress = progress;
let sceneVisible = true;
let frameId = 0;
let lastTime = 0;
let ambient = 0;
let playbackPaused = reduced;
let hasVideoFrame = false;
let changeTimer;
let toastTimer;
let settled = false;
let customIdea = '';
let tiles = [];
let dragStart = null;
let dragged = false;
let currentStep = 0;

function buildWall() {
  count = width < 700 ? 15 : 21;
  selected = clamp(selected, 0, count - 1);
  selectedSmooth = selected;
  wall.replaceChildren();
  tiles = Array.from({ length:count }, (_, index) => {
    const reel = reels[index % reels.length];
    const button = document.createElement('button');
    button.className = 'reel-plane';
    button.setAttribute('aria-label', `Preview ${reel.title}`);
    button.setAttribute('aria-pressed', String(index === selected));
    button.tabIndex = -1;
    const image = document.createElement('img');
    image.src = `./media/reel-${reel.file}.jpg`;
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    const name = document.createElement('span');
    name.className = 'plane-name';
    name.textContent = reel.title;
    button.append(image, name);
    button.addEventListener('click', () => { if (!dragged && settled) selectReel(index); });
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
  const oldMobile = width < 700;
  width = innerWidth;
  height = stage.clientHeight;
  sceneTop = experience.offsetTop;
  travel = Math.max(1, experience.offsetHeight - height);
  if (oldMobile !== (width < 700)) { buildWall(); updateReel(false); }
  tiles.forEach((tile,index)=>{const pose=tilePose(index,selected,progress,width,height);tile.style.width=`${pose.width}px`;tile.style.height=`${pose.height}px`;});
  readScroll();
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
  if (Math.abs(progress - targetProgress) < .0001) progress = targetProgress;
  if (dragStart?.horizontal) selectedSmooth = dragStart.position;
  else {
    selectedSmooth = lerp(selectedSmooth, selected, reduced ? 1 : 1 - Math.exp(-dt / 130));
    if (Math.abs(selectedSmooth - selected) < .001) selectedSmooth = selected;
  }
  if (!reduced && sceneVisible && !playbackPaused && progress < .5) ambient += dt * .000015;
  const state = sceneState(progress);
  const elapsed = reduced ? 2 : (time - bootTime) / 1000;
  const entrance = phase(elapsed, 0, 1.6);
  const drift = reduced ? 0 : Math.sin(ambient) * .055;
  tiles.forEach((tile, index) => {
    const pose = tilePose(index, selectedSmooth, progress, width, height, drift);
    const load = loadPose(elapsed, index, width, height, Math.max(progress,targetProgress));
    tile.style.transform = `translate(-50%,-50%) translate3d(${(pose.x+load.x).toFixed(2)}px,${(pose.y+load.y).toFixed(2)}px,${(pose.z+load.z).toFixed(2)}px) rotateX(${load.pitch.toFixed(2)}deg) rotateY(${(pose.yaw+load.yaw).toFixed(2)}deg) rotateZ(${load.roll.toFixed(2)}deg) scale(${(pose.scale*load.scale).toFixed(4)})`;
    tile.style.opacity = String(pose.opacity * load.opacity);
    tile.style.zIndex = String(100 - Math.round(Math.abs(index - selectedSmooth)));
    tile.tabIndex = settled && pose.opacity > .5 ? (index === selected ? 0 : -1) : -1;
    tile.style.pointerEvents = settled && pose.opacity > .5 ? 'auto' : 'none';
  });
  $('.wall-shade').style.opacity = state.shade;
  intro.style.opacity = String(state.intro);
  intro.style.transform = `translateY(${-phase(progress,.02,.25)*48}px)`;
  headlineLines.forEach((line,index)=>{
    const reveal=phase(elapsed,.26+index*.16,.96+index*.2);
    line.style.transform=`translateY(${(1-reveal)*115}%) rotateZ(${(1-reveal)*(index?-2:2)}deg)`;
    line.style.opacity=String(phase(reveal,0,.5));
  });
  const kickerReveal=phase(elapsed,.42,.95);
  introKicker.style.opacity=String(kickerReveal);
  introKicker.style.transform=`translateY(${(1-kickerReveal)*16}px)`;
  const captionReveal=phase(elapsed,.8,1.3);
  introCaption.style.opacity=String(captionReveal);
  introCaption.style.transform=`translateY(${(1-captionReveal)*24}px)`;
  const cueReveal=phase(elapsed,1.05,1.55);
  introScroll.style.opacity=String(cueReveal);
  introScroll.inert=cueReveal<.9;
  const headerReveal=phase(elapsed,.45,1.15);
  siteHead.style.opacity=String(headerReveal);
  siteHead.style.transform=`translateY(${(1-headerReveal)*-24}px)`;
  siteHead.inert=headerReveal<.8;
  intro.inert = state.intro < .5;
  intro.setAttribute('aria-hidden', String(state.intro < .5));
  product.style.opacity = state.product;
  product.style.transform = `translateY(${(1-state.product)*32}px)`;
  setVisibility(product, state.product > .8);
  phone.style.opacity = state.device;
  const phoneX = width < 700 ? '-50%' : '-50%';
  phone.style.transform = `translateX(${phoneX}) translateY(${(1-state.device)*height*.21}px) rotateY(${(1-state.device)*-38}deg) rotateZ(${(1-state.device)*8}deg) scale(${lerp(.72,1,state.device)})`;
  setVisibility(phone, state.device > .9);
  rail.style.opacity = state.rail;
  setVisibility(rail, state.rail > .9);
  $('.scene-progress span').style.transform = `scaleY(${progress})`;
  const isSettled = state.rail > .92;
  if (settled !== isSettled) { settled = isSettled; stage.classList.toggle('settled', settled); }
  if ((sceneVisible && !reduced && !playbackPaused) || progress !== targetProgress || selectedSmooth !== selected || entrance < 1) requestFrame();
}

function requestFrame() { if (!frameId && !document.hidden) frameId = requestAnimationFrame(draw); }
let bootTime = performance.now();

function updatePlayback() {
  const data = reels[selected % reels.length];
  const shouldPlay = data.video && !playbackPaused && sceneVisible && !document.hidden && !film.open;
  document.body.classList.toggle('is-paused', reduced || playbackPaused || !sceneVisible || document.hidden);
  if (shouldPlay) video.play().then(() => { if(reels[selected % reels.length].video){hasVideoFrame = true; video.classList.add('is-playing');} }).catch(() => { video.classList.remove('is-playing'); });
  else video.pause();
  if (!data.video || !hasVideoFrame) video.classList.remove('is-playing');
  $('#toggle-playback').setAttribute('aria-label', playbackPaused ? 'Play reel' : 'Pause reel');
  $('#toggle-playback use').setAttribute('href', playbackPaused ? '#play' : '#pause');
  requestFrame();
}

function updateReel(animate = true) {
  const data = reels[selected % reels.length];
  const apply = () => {
    poster.src = `./media/reel-${data.file}.jpg`;
    poster.alt = data.title;
    poster.classList.toggle('is-static', reduced);
    $('#screen-title').textContent = customIdea || data.screen;
    $('#screen-title').style.whiteSpace = customIdea ? 'normal' : 'pre-line';
    $('#reel-caption').textContent = data.caption;
    $('#active-title').textContent = data.title;
    $('#active-category').textContent = data.category;
    $('#reel-counter').textContent = `${String(selected+1).padStart(2,'0')} / ${count}`;
    tiles.forEach((tile,i) => { tile.classList.toggle('is-selected',i === selected); tile.setAttribute('aria-pressed',String(i===selected)); });
    $('#previous-reel').disabled = selected === 0;
    $('#next-reel').disabled = selected === count - 1;
    if (data.video) { video.currentTime = 0; hasVideoFrame = false; }
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
  const next = clamp(Math.round(index),0,count - 1);
  if (next === selected) return;
  selected = next;
  customIdea = '';
  updateReel();
  requestFrame();
  if (focus) tiles[selected]?.focus({ preventScroll:true });
}

function goToProduct() {
  window.scrollTo({ top:reduced ? sceneTop : sceneTop + travel * .94, behavior:reduced ? 'instant' : 'smooth' });
  if (reduced) readScroll();
}

$$('[data-jump]').forEach(button => button.addEventListener('click',goToProduct));
$('.skip-link').addEventListener('click',event=>{event.preventDefault();goToProduct();setTimeout(()=>{$('.product-copy h2').tabIndex=-1;$('.product-copy h2').focus({preventScroll:true});},reduced?0:800);});
$('#previous-reel').addEventListener('click',() => selectReel(selected-1));
$('#next-reel').addEventListener('click',() => selectReel(selected+1));
wall.addEventListener('pointerdown',event => { if (!settled || dragStart || !event.isPrimary || event.button > 0) return; dragStart={ x:event.clientX, y:event.clientY, selected, position:selected, lastX:event.clientX, lastTime:event.timeStamp, velocity:0, horizontal:false, pointerId:event.pointerId }; dragged=false; });
wall.addEventListener('pointermove',event => {
  if (!dragStart || event.pointerId !== dragStart.pointerId) return;
  const dx=event.clientX-dragStart.x;
  if (Math.abs(dx)>10 && Math.abs(dx)>Math.abs(event.clientY-dragStart.y)) {
    if(!dragStart.horizontal) wall.setPointerCapture(event.pointerId);
    dragStart.horizontal=true;dragged=true;wall.style.cursor='grabbing';
  }
  if(dragStart.horizontal){
    const step=(width<700?138:Math.min(236,width*.165))+(width<700?12:20);
    const dt=Math.max(1,event.timeStamp-dragStart.lastTime);
    dragStart.velocity=lerp(dragStart.velocity,(event.clientX-dragStart.lastX)/dt,.45);
    dragStart.position=clamp(dragStart.selected-dx/step,0,count-1);
    dragStart.lastX=event.clientX;dragStart.lastTime=event.timeStamp;
    requestFrame();
  }
});
window.addEventListener('pointerup',event => {
  if (!dragStart || event.pointerId !== dragStart.pointerId) return;
  if (dragged) {
    const step=(width<700?138:Math.min(236,width*.165))+(width<700?12:20);
    const velocity=event.timeStamp-dragStart.lastTime<100?dragStart.velocity:0;
    selectReel(dragStart.position-clamp(velocity*110/step,-1.4,1.4));
  }
  if(wall.hasPointerCapture(event.pointerId))wall.releasePointerCapture(event.pointerId);
  dragStart=null;wall.style.cursor='';
  requestFrame();
  setTimeout(()=>{ dragged=false; },0);
});
window.addEventListener('pointercancel',event=>{if(dragStart && event.pointerId===dragStart.pointerId){dragStart=null;dragged=false;wall.style.cursor='';requestFrame();}});

$('#toggle-playback').addEventListener('click',()=>{playbackPaused=!playbackPaused;updatePlayback();});
$('#silent-sample').addEventListener('click',()=>showToast('This sample clip is silent.'));
$$('[data-toggle]').forEach(button=>button.addEventListener('click',()=>{
  const active=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(active));
  showToast(button.dataset.toggle==='save' ? active?'Sample saved for this visit.':'Sample removed from saved.':active?'A little love for this idea.':'Like removed.');
}));
function showToast(text) { const toast=$('#toast');toast.textContent=text;toast.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('is-visible'),3000); }
$('#share-reel').addEventListener('click',async()=>{
  const url=new URL(location.href);url.hash='reels';
  try { await navigator.clipboard.writeText(url.href);showToast('Showcase link copied.'); } catch { showToast('Share this showcase using the page URL.'); }
});

$$('[data-studio]').forEach(button=>button.addEventListener('click',()=>{studio.showModal();setTimeout(()=>$('#idea-input').focus(),0);}));
$$('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>studio.close()));
studio.addEventListener('click',event=>{if(event.target===studio){const rect=studio.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)studio.close();}});
$('#idea-input').addEventListener('input',()=>{$('#idea-count').textContent=`${$('#idea-input').value.length} / 140`;});
$('#idea-form').addEventListener('submit',event=>{
  event.preventDefault();
  const input=$('#idea-input').value.trim();if(!input){$('#idea-input').setCustomValidity('Add a little idea to preview.');$('#idea-input').reportValidity();return;}
  $('#idea-input').setCustomValidity('');
  selected=Number(new FormData(event.currentTarget).get('mood'));
  customIdea=input.length>64?`${input.slice(0,61).trim()}…`:input;
  updateReel(false);studio.close();goToProduct();showToast('Your idea is in the concept preview.');
});
$('#idea-input').addEventListener('input',()=>$('#idea-input').setCustomValidity(''));
$('#watch-film').addEventListener('click',()=>{film.showModal();updatePlayback();filmVideo.play().catch(()=>{});});
$$('[data-close-film]').forEach(button=>button.addEventListener('click',()=>film.close()));
film.addEventListener('close',()=>{filmVideo.pause();updatePlayback();});
film.addEventListener('click',event=>{if(event.target===film)film.close();});
function replayWall(){
  window.scrollTo({top:0,behavior:'instant'});
  bootTime=performance.now();lastTime=0;
  progress=targetProgress=reduced?1:0;
  stage.tabIndex=-1;stage.focus({preventScroll:true});
  requestFrame();
}
$('#replay-intro').addEventListener('click',replayWall);

const opening=$('#opening-cut');
let openingTimer;
function playOpening() {
  if(reduced){goToProduct();showToast('Reduced motion is on. Showing the product directly.');return;}
  window.scrollTo({top:0,behavior:'instant'});
  opening.classList.remove('is-running');
  opening.showModal();
  void opening.offsetWidth;
  opening.classList.add('is-running');
  $('#skip-opening').focus();
  clearTimeout(openingTimer);
  openingTimer=setTimeout(()=>opening.close(),2800);
}
$('#play-opening').addEventListener('click',playOpening);
$('#skip-opening').addEventListener('click',()=>opening.close());
opening.addEventListener('close',()=>{clearTimeout(openingTimer);opening.classList.remove('is-running');replayWall();});

function setStep(index,focus=false) {
  currentStep=clamp(index,0,2);
  const ids=['step-idea','step-story','step-reel'];
  const panels=[$('.idea-demo'),$('.story-demo'),$('.publish-demo')];
  $$('.workflow-step').forEach((button,i)=>{const active=i===currentStep;button.classList.toggle('is-active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
  panels.forEach((panel,i)=>panel.hidden=i!==currentStep);
  $('#workflow-visual').setAttribute('aria-labelledby',ids[currentStep]);
  $('.demo-position').textContent=['IDEA / 01','STORY / 02','REEL / 03'][currentStep];
  if(focus) $$('.workflow-step')[currentStep].focus();
}
$$('.workflow-step').forEach((button,i)=>{button.addEventListener('click',()=>setStep(i));button.addEventListener('keydown',event=>{const delta=event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0;if(delta){event.preventDefault();setStep((currentStep+delta+3)%3,true);}if(event.key==='Home'||event.key==='End'){event.preventDefault();setStep(event.key==='Home'?0:2,true);}});});

const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-revealed');revealObserver.unobserve(entry.target);}}),{threshold:.15});
$$('.reveal').forEach(element=>revealObserver.observe(element));
const manifesto=$('#manifesto-text');
manifesto.innerHTML=manifesto.innerHTML.split(/(<br\s*\/?\s*>|\s+)/).map(token=>token.trim() && !token.startsWith('<br')?`<span class="word">${token}</span>`:token).join('');
const wordObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-read');wordObserver.unobserve(entry.target);}}),{rootMargin:'0px 0px -15% 0px',threshold:1});
$$('.manifesto-statement .word').forEach((word,i)=>{word.style.transitionDelay=`${(i%6)*40}ms`;wordObserver.observe(word);});
const sceneObserver=new IntersectionObserver(([entry])=>{sceneVisible=entry.isIntersecting;updatePlayback();},{threshold:0});
sceneObserver.observe(experience);
const workflowObserver=new IntersectionObserver(([entry])=>{$('.workflow-visual').classList.toggle('is-paused',!entry.isIntersecting);},{threshold:.1});
workflowObserver.observe($('.workflow-visual'));
window.addEventListener('scroll',readScroll,{passive:true});
window.addEventListener('resize',measure,{passive:true});
document.addEventListener('visibilitychange',()=>{lastTime=0;updatePlayback();if(!document.hidden)readScroll();});
motionPreference.addEventListener('change',event=>{reduced=event.matches;if(reduced)playbackPaused=true;progress=reduced?1:progress;measure();updateReel(false);});
window.addEventListener('keydown',event=>{if(event.key==='Escape'){dragStart=null;dragged=false;}});
video.addEventListener('error',()=>{video.classList.remove('is-playing');showToast('Showing the poster while the sample video is unavailable.');});

buildWall();measure();updateReel(false);setStep(0);requestFrame();
if(location.hash==='#product'||location.hash==='#reels') requestAnimationFrame(goToProduct);
if(new URLSearchParams(location.search).get('intro')==='1'&&!reduced) requestAnimationFrame(playOpening);
