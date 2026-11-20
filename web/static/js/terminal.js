// Web virtual terminal client (AGT-4002). Opt-in on the server
// (OPENSWARM_WEB_TERMINAL=1); this page is only routed when it is on.
//
// A browser cannot put headers on a WebSocket, so the web token from
// webToken.js travels as a Sec-WebSocket-Protocol entry, never in the URL.
(function () {
  'use strict';

  var PROTOCOL = 'openswarm.terminal.v1';
  var TOKEN_PREFIX = 'openswarm.token.';

  function base64url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function protocols() {
    var api = window.OpenSwarmWebToken;
    var token = api && typeof api.readToken === 'function' ? api.readToken() : '';
    return token ? [PROTOCOL, TOKEN_PREFIX + base64url(token)] : [PROTOCOL];
  }

  function socketUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws';
  }

  var stateEl = document.getElementById('terminal-state');
  var reconnectEl = document.getElementById('terminal-reconnect');

  function setState(text, tone) {
    stateEl.textContent = text;
    stateEl.dataset.tone = tone || '';
  }

  if (typeof window.Terminal !== 'function' || !window.FitAddon) {
    setState('Terminal assets are missing (run npm run build).', 'danger');
    return;
  }

  var term = new window.Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000 });
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  var socket = null;

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function resize() {
    try { fit.fit(); } catch { /* hidden or zero-size container */ }
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }

  var CLOSE_REASONS = { 1013: 'Too many terminal sessions are open.', 1011: 'The shell could not start.' };

  function connect() {
    reconnectEl.hidden = true;
    setState('Connecting…', 'warn');
    socket = new WebSocket(socketUrl(), protocols());
    socket.onopen = function () {
      setState('Connected', 'ok');
      resize();
      term.focus();
    };
    socket.onmessage = function (event) {
      if (typeof event.data === 'string') term.write(event.data);
    };
    socket.onclose = function (event) {
      var reason = CLOSE_REASONS[event.code] || event.reason || (event.code === 1006 ? 'Connection refused or lost (check the web token).' : 'Disconnected.');
      setState(reason, event.code === 1000 ? 'warn' : 'danger');
      reconnectEl.hidden = false;
      socket = null;
    };
  }

  term.onData(function (data) { send({ type: 'input', data: data }); });
  window.addEventListener('resize', resize);
  reconnectEl.addEventListener('click', connect);
  connect();
})();
