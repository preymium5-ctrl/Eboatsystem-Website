// ESMI homepage hero: after the four-tile intro has played, run it in reverse so the tiles
// close up and vanish, revealing the dock landing video from D:\ESMI WEB with its cursor
// camera movement and water ripples (landing-effects.js, unchanged from that project).
import {setupLandingEffects} from './landing-effects.js';

const HOLD = 2.4;                 // seconds the finished intro stays on screen before reversing
const accueil = document.querySelector('#accueil');
const landing = document.querySelector('#landing');
const video = document.querySelector('#landing-video');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

if (accueil && landing && video) {
  // Portrait phones get the portrait dock video, everything else the landscape one.
  const portrait = matchMedia('(max-width:760px)').matches && matchMedia('(max-aspect-ratio:4/5)').matches;
  const variant = portrait ? 'portrait' : 'desktop';
  landing.dataset.mediaVariant = variant;
  video.poster = video.dataset[`${variant}Poster`];
  video.src = video.dataset[`${variant}Src`];
  video.load();

  let effects = null;
  function play() { video.play().catch(() => { video.style.opacity = '0'; }); }
  video.addEventListener('playing', () => { video.style.opacity = '1'; }, {once: true});
  play();                         // muted, under the tiles: decoded and ready by the time it is revealed
  document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); else if (landing.classList.contains('is-on')) play(); });

  function finish() {
    accueil.classList.add('heroLandingDone');
    if (!effects) effects = setupLandingEffects({landing, video, menu: null, reducedMotion: reduced});
    play();
  }

  function reverseIntro() {
    const g = window.gsap;
    landing.classList.add('is-on');
    if (!g || reduced.matches) { finish(); return; }
    const words = document.querySelectorAll('#a3 strong b');
    const lift = words[0] ? words[0].offsetHeight + 5 : 30;
    const shut = {
      up:   'polygon(0% 0%, 100% 0%, 100% 0%, 0% 0%)',          // closes toward the top (reverse of a top-down reveal)
      down: 'polygon(0% 100%, 100% 100%, 100% 100%, 0% 100%)',  // closes toward the bottom (reverse of a bottom-up reveal)
    };
    // Mirror of the intro in Comportements-v4.js, played backwards: words out, then the right
    // column (a3/a4), then the left column (a1/a2), each image easing out as its tile closes.
    const tl = g.timeline({onComplete: finish});
    tl.to(words, {y: lift, opacity: 0, duration: .6, stagger: {each: .08, from: 'end'}, ease: 'power2.in'})
      .to('#a3', {clipPath: shut.down, duration: 1.4, ease: 'power3.inOut'}, '-=.25')
      .to('#a3 img', {opacity: 0, duration: 1.4, ease: 'power3.inOut'}, '<')
      .to('#a4', {clipPath: shut.up, duration: 1.4, ease: 'power3.inOut'}, '<.05')
      .to('#a4 img', {opacity: 0, y: -200, duration: 1.4, ease: 'power3.inOut'}, '<')
      .to('#a1', {clipPath: shut.down, duration: 1.4, ease: 'power3.inOut'}, '<.1')
      .to('#a1 img', {opacity: 0, y: 200, duration: 1.4, ease: 'power3.inOut'}, '<')
      .to('#a2', {clipPath: shut.up, duration: 1.4, ease: 'power3.inOut'}, '<')
      .to('#a2 img', {opacity: 0, duration: 1.4, ease: 'power3.inOut'}, '<');
  }

  // Wait for the intro (run by Comportements-v4.js after the loader) to be fully on screen,
  // then hold it for a moment before reversing.
  const a1 = document.querySelector('#a1');
  const words = document.querySelector('#a3 strong b');
  function introDone() {
    const g = window.gsap;
    if (!g || !a1) return true;
    const busy = g.getTweensOf([a1, '#a2', '#a3', '#a4', '#a3 strong b']).some(t => t.isActive());
    const shown = getComputedStyle(a1).opacity === '1' && (!words || getComputedStyle(words).visibility === 'visible');
    return shown && !busy;
  }
  const started = performance.now();
  (function wait() {
    if (introDone() || performance.now() - started > 15000) setTimeout(reverseIntro, HOLD * 1000);
    else setTimeout(wait, 150);
  })();
}
