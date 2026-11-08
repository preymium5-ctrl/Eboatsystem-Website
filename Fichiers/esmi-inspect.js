/* ESMI: full-screen 3D "Inspect" viewer (inspect/index.html) opened over the page.
   Any element with data-esmi-inspect opens it; the viewer's Close button, Escape or the browser back gesture close it. */
(function () {
  var overlay = null, frame = null, lastFocus = null;
  var SRC = 'inspect/index.html';

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'esmiInspect';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Inspect the ESMI boat in 3D');
    frame = document.createElement('iframe');
    frame.title = 'Inspect the ESMI boat in 3D';
    frame.setAttribute('allow', 'fullscreen');
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
  }

  function open(e) {
    if (e) e.preventDefault();
    if (!overlay) build();
    if (overlay.classList.contains('on')) return;
    lastFocus = document.activeElement;
    frame.src = SRC;                                   // fresh load each time (the viewer frees its 3D memory on close)
    document.documentElement.classList.add('esmiInspectOpen');
    requestAnimationFrame(function () { overlay.classList.add('on'); });
    frame.addEventListener('load', function () { try { frame.contentWindow.focus(); } catch (err) {} }, { once: true });
  }

  function close() {
    if (!overlay || !overlay.classList.contains('on')) return;
    overlay.classList.remove('on');
    document.documentElement.classList.remove('esmiInspectOpen');
    setTimeout(function () { if (!overlay.classList.contains('on')) frame.src = 'about:blank'; }, 500);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-esmi-inspect]') : null;
    if (t) open(e);
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target.closest ? e.target.closest('[data-esmi-inspect]') : null;
    if (t && (e.key === 'Enter' || e.key === ' ')) open(e);
    if (e.key === 'Escape') close();
  });
  window.addEventListener('message', function (e) {
    if (e.data && e.data.esmiInspect === 'close') close();
  });
})();
