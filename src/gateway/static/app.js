/* ============================================================
   HIVE Web UI — app.js
   REST client, WebSocket connection, DOM rendering.
   No frameworks. No build step. No dependencies.
   ============================================================ */

// --- State ---

const state = {
  project: null,
  supervisorStatus: null,
  agentCount: 0,
  ws: null,
  wsConnected: false,
  wsReconnectDelay: 1000,
  wsMaxReconnectDelay: 30000,
  feedEntries: [],
  consoleHistory: [],
};


// --- API Client ---

const API_BASE = '';  // same origin

async function apiGet(path) {
  const res = await fetch(API_BASE + '/api' + path);
  if (!res.ok) {
    throw new Error('API ' + res.status + ': ' + (await res.text()));
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + '/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('API ' + res.status + ': ' + (await res.text()));
  }
  return res.json();
}


// --- Utilities ---

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function nowISO() {
  return new Date().toISOString();
}

function nowTimeString() {
  return formatTime(nowISO());
}


// --- Connection Status ---

function setConnectionStatus(connected) {
  state.wsConnected = connected;
  var container = document.getElementById('connection-status');
  if (!container) return;

  var dot = container.querySelector('.status-dot');
  var label = container.querySelector('span:last-child');

  if (connected) {
    dot.className = 'status-dot status-dot--connected';
    label.textContent = 'connected';
    container.className = 'topbar-connection state-connected';
  } else {
    dot.className = 'status-dot status-dot--disconnected';
    label.textContent = 'disconnected';
    container.className = 'topbar-connection state-disconnected';
  }
}


// --- WebSocket ---

function connectWebSocket() {
  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = protocol + '//' + location.host + '/ws';
  var ws;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('WebSocket creation failed:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = function () {
    console.log('WS connected');
    state.wsReconnectDelay = 1000; // reset backoff
    setConnectionStatus(true);
  };

  ws.onmessage = function (event) {
    try {
      var msg = JSON.parse(event.data);
      handleWsEvent(msg);
    } catch (e) {
      console.error('WS message parse error:', e);
    }
  };

  ws.onclose = function () {
    console.log('WS disconnected');
    setConnectionStatus(false);
    state.ws = null;
    scheduleReconnect();
  };

  ws.onerror = function (e) {
    console.error('WS error:', e);
    // onclose will fire after this, triggering reconnect
  };

  state.ws = ws;
}

function scheduleReconnect() {
  var delay = state.wsReconnectDelay;
  console.log('Reconnecting in ' + (delay / 1000) + 's...');
  setTimeout(connectWebSocket, delay);
  // Exponential backoff with cap
  state.wsReconnectDelay = Math.min(
    state.wsReconnectDelay * 2,
    state.wsMaxReconnectDelay
  );
}

function handleWsEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'feed':
      addFeedEntry(event);
      break;
    case 'board-changed':
    case 'run-changed':
    case 'state-changed':
    case 'run-started':
    case 'run-completed':
    case 'supervisor-tick':
      refreshStatus();
      break;
    case 'console-response':
    case 'session-message':
      if (event.data && event.data.content) {
        addConsoleTurn('assistant', event.data.content);
      }
      break;
  }
}


// --- DOM: Feed Panel ---

function classifyFeedStatus(entry) {
  if (!entry) return '';
  var text = ((entry.data && entry.data.raw) || entry.type || '').toLowerCase();
  if (text.indexOf('error') !== -1 || text.indexOf('fail') !== -1 || text.indexOf('crash') !== -1) {
    return 'error';
  }
  if (text.indexOf('complete') !== -1 || text.indexOf('done') !== -1 || text.indexOf('success') !== -1) {
    return 'success';
  }
  if (text.indexOf('warn') !== -1 || text.indexOf('block') !== -1 || text.indexOf('stuck') !== -1) {
    return 'warning';
  }
  return 'info';
}

function renderFeedEntry(entry) {
  var div = document.createElement('div');
  div.className = 'feed-entry';

  var ts = entry.ts || nowISO();
  var headline = (entry.data && entry.data.raw) || (entry.data && entry.data.headline) || entry.type || '';
  var details = (entry.data && entry.data.details) || '';
  var status = classifyFeedStatus(entry);

  var html = '<div class="feed-entry-time">' + escapeHtml(formatTime(ts)) + '</div>';
  html += '<div class="feed-entry-headline">';
  html += '<span class="feed-entry-status feed-entry-status--' + status + '"></span>';
  html += escapeHtml(headline);
  html += '</div>';

  if (details) {
    var detailText = Array.isArray(details) ? details.join(', ') : String(details);
    html += '<div class="feed-entry-details">' + escapeHtml(detailText) + '</div>';
  }

  div.innerHTML = html;
  return div;
}

function addFeedEntry(entry) {
  var container = document.getElementById('feed-entries');
  if (!container) return;

  // Remove empty state if present
  var empty = container.querySelector('.feed-empty');
  if (empty) empty.remove();

  state.feedEntries.push(entry);
  container.appendChild(renderFeedEntry(entry));

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function renderFeedEntries(entries) {
  var container = document.getElementById('feed-entries');
  if (!container) return;

  container.innerHTML = '';

  if (!entries || entries.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'feed-empty';
    empty.textContent = 'No feed entries yet. Activity will appear here.';
    container.appendChild(empty);
    return;
  }

  for (var i = 0; i < entries.length; i++) {
    container.appendChild(renderFeedEntry(entries[i]));
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}


// --- DOM: Console Panel ---

function addConsoleTurn(role, content, timestamp) {
  var container = document.getElementById('console-history');
  if (!container) return;

  // Remove welcome message on first turn
  var welcome = container.querySelector('.console-welcome');
  if (welcome) welcome.remove();

  var ts = timestamp || nowISO();

  var div = document.createElement('div');
  div.className = 'turn turn-' + role;

  var html = '';
  html += '<span class="turn-time">' + escapeHtml(formatTime(ts)) + '</span>';
  html += '<div class="turn-role">' + escapeHtml(role) + '</div>';
  html += '<div class="turn-content">' + escapeHtml(content) + '</div>';

  div.innerHTML = html;
  container.appendChild(div);

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;

  state.consoleHistory.push({ role: role, content: content, ts: ts });
}


// --- Status Updates ---

function updateTopBar(data) {
  if (!data) return;

  // Project name
  var projectEl = document.getElementById('project-name');
  if (projectEl) {
    projectEl.textContent = data.project || state.project || '\u2014';
  }

  // Supervisor status
  var dotEl = document.getElementById('supervisor-dot');
  var labelEl = document.getElementById('supervisor-label');

  if (data.supervisor) {
    var supStatus = data.supervisor.status || 'unknown';
    if (dotEl) {
      dotEl.className = 'status-dot';
      if (supStatus === 'active' || supStatus === 'running') {
        dotEl.classList.add('status-dot--active');
      } else if (supStatus === 'error' || supStatus === 'crashed') {
        dotEl.classList.add('status-dot--error');
      } else {
        dotEl.classList.add('status-dot--stopped');
      }
    }
    if (labelEl) {
      labelEl.textContent = 'supervisor ' + supStatus;
    }
  } else if (labelEl) {
    labelEl.textContent = '\u2014';
  }

  // Agent count
  var agentEl = document.getElementById('agent-count');
  if (agentEl) {
    var count = data.agents || data.agentCount || 0;
    if (typeof count === 'number' && count > 0) {
      agentEl.textContent = count + ' agent' + (count !== 1 ? 's' : '');
    } else {
      agentEl.textContent = '\u2014';
    }
  }
}

async function refreshStatus() {
  try {
    var data = await apiGet('/status');
    // The status endpoint may return different shapes.
    // Try to extract project, supervisor, and agent info.
    var parsed = {
      project: null,
      supervisor: null,
      agents: 0,
    };

    if (data.result && typeof data.result === 'string') {
      // Parse "Project: xxx" from the result text
      var projectMatch = data.result.match(/^Project:\s*(.+)$/m);
      if (projectMatch) {
        parsed.project = projectMatch[1].trim();
        state.project = parsed.project;
      }
    } else if (data.project) {
      parsed.project = data.project;
      state.project = data.project;
    }

    if (data.supervisor) {
      parsed.supervisor = data.supervisor;
    }

    if (data.agents !== undefined) {
      parsed.agents = data.agents;
    } else if (data.agentCount !== undefined) {
      parsed.agents = data.agentCount;
    }

    updateTopBar(parsed);
  } catch (e) {
    // API unreachable — show degraded state
    console.error('Status refresh failed:', e);
    var projectEl = document.getElementById('project-name');
    if (projectEl && !state.project) {
      projectEl.textContent = '\u2014';
    }
  }
}

async function refreshFeed() {
  try {
    var data = await apiGet('/feed?count=50');

    // data may be { result: "..." } with feed text, or { entries: [...] }
    if (data.entries && Array.isArray(data.entries)) {
      state.feedEntries = data.entries;
      renderFeedEntries(data.entries);
    } else if (data.result && typeof data.result === 'string') {
      // Parse feed text into entries
      var entries = parseFeedText(data.result);
      state.feedEntries = entries;
      renderFeedEntries(entries);
    } else {
      renderFeedEntries([]);
    }
  } catch (e) {
    console.error('Feed refresh failed:', e);
    renderFeedEntries([]);
  }
}

function parseFeedText(text) {
  if (!text || !text.trim()) return [];

  var lines = text.split('\n');
  var entries = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    // Feed lines look like: "[2026-03-10 14:52] alpha: Task 001 complete"
    // or "- [timestamp] content"
    // or just "content"
    var tsMatch = line.match(/^\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?Z?)\]?\s*(.+)/);
    var headline;
    var ts;

    if (tsMatch) {
      ts = tsMatch[1];
      headline = tsMatch[2];
    } else {
      // Strip leading "- " if present
      headline = line.replace(/^-\s*/, '');
      ts = null;
    }

    entries.push({
      type: 'feed',
      ts: ts,
      data: { raw: headline },
    });
  }

  return entries;
}


// --- Console Input ---

function setupConsoleInput() {
  var form = document.getElementById('console-form');
  var input = document.getElementById('console-input');

  if (!form || !input) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    sendConsoleMessage();
  });

  // Enter to send (no shift), Shift+Enter for newline (if we ever switch to textarea)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendConsoleMessage();
    }
  });
}

async function sendConsoleMessage() {
  var input = document.getElementById('console-input');
  if (!input) return;

  var message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.focus();

  // Show human turn immediately
  addConsoleTurn('human', message);

  try {
    var data = await apiPost('/say', { message: message });

    // Response may come via WebSocket (console-response event) or
    // directly in the response body
    if (data.result) {
      addConsoleTurn('assistant', data.result);
    }
  } catch (e) {
    addConsoleTurn('error', 'Error: ' + e.message);
  }
}


// --- Console History Load ---

async function loadConsoleHistory() {
  try {
    var data = await apiGet('/console/history');

    if (data.turns && Array.isArray(data.turns)) {
      for (var i = 0; i < data.turns.length; i++) {
        var turn = data.turns[i];
        addConsoleTurn(turn.role || 'assistant', turn.content || '', turn.ts);
      }
    }
  } catch (e) {
    // Console history endpoint may not exist yet — that is fine
    console.log('Console history not available:', e.message);
  }
}


// --- Initialization ---

async function init() {
  // Set up console input handler
  setupConsoleInput();

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Show initial empty feed state
  renderFeedEntries([]);

  // Load initial data from API (non-blocking, graceful on failure)
  refreshStatus();
  refreshFeed();
  loadConsoleHistory();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
