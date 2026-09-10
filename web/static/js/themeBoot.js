// Theme bootstrap — a classic (non-module) script so it runs synchronously in
// <head>, before first paint. A deferred module would let the dark default
// flash for one frame on a light-preferring machine. (AGT-4201, §1.1/§6.4)
//
// Resolution: an explicit choice stored by theme.mjs wins; otherwise follow
// the OS. tokens.css only knows `[data-theme="light"]` — dark is the base.
(function () {
  var theme = 'dark';
  try {
    var stored = window.localStorage.getItem('openswarm.theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch (_) { /* storage blocked — stay on the dark default */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
