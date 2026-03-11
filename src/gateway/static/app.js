/* ============================================================
   HIVE Web UI — app.js
   REST client, WebSocket connection, DOM rendering.
   No frameworks. No build step. No dependencies.
   ============================================================ */

// --- State ---

var state = {
  project: null,
  supervisorStatus: null,
  agentCount: 0,
  agents: [],
  ws: null,
  wsConnected: false,
  wsReconnectDelay: 1000,
  wsMaxReconnectDelay: 30000,
  feedEntries: [],
  consoleHistory: [],
  sessionId: null,
  sending: false,
};


// --- API Client ---

var API_BASE = '';  // same origin

async function apiGet(path) {
  var res = await fetch(API_BASE + '/api' + path);
  if (!res.ok) {
    throw new Error('API ' + res.status + ': ' + (await res.text()));
  }
  return res.json();
}

async function apiPost(path, body) {
  var res = await fetch(API_BASE + '/api' + path, {
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

function isMac() {
  return navigator.platform && navigator.platform.indexOf('Mac') !== -1;
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
      refreshAgentOverview();
      break;
    case 'console-response':
    case 'session-message':
      if (event.data && event.data.content) {
        removeThinkingIndicator();
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

  // Remove loading state
  var loading = container.querySelector('.console-loading');
  if (loading) loading.remove();

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

function showThinkingIndicator() {
  var container = document.getElementById('console-history');
  if (!container) return;

  var div = document.createElement('div');
  div.className = 'turn turn-thinking';
  div.id = 'thinking-indicator';

  var html = '';
  html += '<div class="turn-role">thinking</div>';
  html += '<div class="turn-content"><span class="thinking-dots">';
  html += '<span></span><span></span><span></span>';
  html += '</span></div>';

  div.innerHTML = html;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeThinkingIndicator() {
  var indicator = document.getElementById('thinking-indicator');
  if (indicator) indicator.remove();
}

function clearConsoleHistory() {
  var container = document.getElementById('console-history');
  if (!container) return;

  container.innerHTML = '';
  state.consoleHistory = [];

  var welcome = document.createElement('div');
  welcome.className = 'console-welcome';
  welcome.innerHTML = '<p>Welcome to HIVE. Type a message to talk to the hive mind.</p>' +
    '<p class="console-welcome-hint">The console is your steering wheel. The feed is your dashboard.</p>';
  container.appendChild(welcome);
}


// --- Session Management ---

function updateSessionIndicator(sessionId) {
  state.sessionId = sessionId;
  var el = document.getElementById('session-id');
  if (!el) return;

  if (sessionId) {
    el.textContent = 'session: ' + sessionId;
    el.title = sessionId;
  } else {
    el.textContent = '\u2014';
    el.title = '';
  }
}

async function createNewSession() {
  try {
    var data = await apiPost('/console/new', {});
    updateSessionIndicator(data.sessionId);
    clearConsoleHistory();
  } catch (e) {
    console.error('Failed to create new session:', e);
    addConsoleTurn('error', 'Failed to create new session: ' + e.message);
  }
}

async function loadSession(sessionId) {
  try {
    var data = await apiGet('/sessions/' + sessionId);

    // Clear and load new history
    var container = document.getElementById('console-history');
    if (container) {
      container.innerHTML = '';
      state.consoleHistory = [];
    }

    updateSessionIndicator(sessionId);

    if (data.turns && Array.isArray(data.turns)) {
      for (var i = 0; i < data.turns.length; i++) {
        var turn = data.turns[i];
        addConsoleTurn(turn.role || 'assistant', turn.content || '', turn.ts);
      }
    }

    if (state.consoleHistory.length === 0) {
      clearConsoleHistory();
    }

    // Close the sessions dropdown
    closeSessionsDropdown();
  } catch (e) {
    console.error('Failed to load session:', e);
    addConsoleTurn('error', 'Failed to load session: ' + e.message);
  }
}


// --- Sessions Dropdown ---

function toggleSessionsDropdown() {
  var dropdown = document.getElementById('sessions-dropdown');
  if (!dropdown) return;

  var isOpen = dropdown.classList.contains('sessions-dropdown--open');
  if (isOpen) {
    closeSessionsDropdown();
  } else {
    openSessionsDropdown();
  }
}

function closeSessionsDropdown() {
  var dropdown = document.getElementById('sessions-dropdown');
  if (dropdown) dropdown.classList.remove('sessions-dropdown--open');
}

async function openSessionsDropdown() {
  var dropdown = document.getElementById('sessions-dropdown');
  var list = document.getElementById('sessions-dropdown-list');
  if (!dropdown || !list) return;

  dropdown.classList.add('sessions-dropdown--open');

  // Fetch sessions
  try {
    var data = await apiGet('/sessions');
    var sessions = data.sessions || [];

    list.innerHTML = '';

    if (sessions.length === 0) {
      list.innerHTML = '<div class="sessions-dropdown-empty">No sessions</div>';
      return;
    }

    for (var i = 0; i < sessions.length; i++) {
      var session = sessions[i];
      var item = document.createElement('div');
      item.className = 'sessions-dropdown-item';
      if (session.sessionId === state.sessionId) {
        item.className += ' sessions-dropdown-item--active';
      }

      var started = session.started ? formatTime(session.started) : '';
      var turns = session.turns || 0;
      item.innerHTML =
        '<div class="sessions-dropdown-item-id">' + escapeHtml(session.sessionId) + '</div>' +
        '<div class="sessions-dropdown-item-meta">' +
        escapeHtml(started) + ' \u00b7 ' + turns + ' turn' + (turns !== 1 ? 's' : '') +
        '</div>';

      // Closure for click handler
      (function (sid) {
        item.addEventListener('click', function () {
          loadSession(sid);
        });
      })(session.sessionId);

      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = '<div class="sessions-dropdown-empty">Failed to load sessions</div>';
    console.error('Failed to load sessions:', e);
  }
}


// --- Agent Overview ---

function parseAgentInfo(psText) {
  if (!psText || typeof psText !== 'string') return [];

  var agents = [];
  var lines = psText.split('\n');
  var inActiveSection = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (line.indexOf('Active runs:') !== -1) {
      inActiveSection = true;
      continue;
    }

    if (inActiveSection) {
      // End of active section
      if (line.trim() === '' || line.indexOf('No ') !== -1 || line.indexOf('Recent ') !== -1) {
        inActiveSection = false;
        continue;
      }

      // Parse agent line: "  alpha  steward   claude  pid:12345  2m ago"
      var parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 3) {
        agents.push({
          name: parts[0],
          persona: parts[1] || '',
          runtime: parts[2] || '',
          age: parts.length >= 5 ? parts[4] : (parts.length >= 4 ? parts[3] : ''),
        });
      }
    }
  }

  return agents;
}

function updateAgentOverview(agents) {
  state.agents = agents;
  state.agentCount = agents.length;

  var labelEl = document.querySelector('.topbar-agents-label');
  if (labelEl) {
    if (agents.length > 0) {
      labelEl.textContent = agents.length + ' agent' + (agents.length !== 1 ? 's' : '');
    } else {
      labelEl.textContent = '\u2014';
    }
  }

  // Update dropdown content
  var list = document.getElementById('agent-dropdown-list');
  if (!list) return;

  list.innerHTML = '';

  if (agents.length === 0) {
    list.innerHTML = '<div class="agent-dropdown-empty">No active agents</div>';
    return;
  }

  for (var i = 0; i < agents.length; i++) {
    var agent = agents[i];
    var item = document.createElement('div');
    item.className = 'agent-dropdown-item';
    item.innerHTML =
      '<span class="agent-dropdown-name">' + escapeHtml(agent.name) + '</span>' +
      '<span class="agent-dropdown-persona">' + escapeHtml(agent.persona) + '</span>' +
      '<span class="agent-dropdown-runtime">' + escapeHtml(agent.runtime) + '</span>' +
      '<span class="agent-dropdown-age">' + escapeHtml(agent.age) + '</span>';
    list.appendChild(item);
  }
}

function toggleAgentDropdown() {
  var dropdown = document.getElementById('agent-dropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('agent-dropdown--open');
}

function closeAgentDropdown() {
  var dropdown = document.getElementById('agent-dropdown');
  if (dropdown) dropdown.classList.remove('agent-dropdown--open');
}

async function refreshAgentOverview() {
  try {
    var data = await apiGet('/ps');
    var text = data.result || '';
    var agents = parseAgentInfo(text);
    updateAgentOverview(agents);
  } catch (e) {
    console.error('Agent overview refresh failed:', e);
    updateAgentOverview([]);
  }
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
}

async function refreshStatus() {
  try {
    var data = await apiGet('/status');
    // The status endpoint may return different shapes.
    // Try to extract project, supervisor, and agent info.
    var parsed = {
      project: null,
      supervisor: null,
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


// --- Loading State ---

function setSendingState(sending) {
  state.sending = sending;
  var input = document.getElementById('console-input');
  var btn = document.getElementById('console-send-btn');

  if (input) {
    input.disabled = sending;
  }
  if (btn) {
    btn.disabled = sending;
    btn.textContent = sending ? 'Sending...' : 'Send';
  }
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

  // Enter to send (no shift), Shift+Enter for newline
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendConsoleMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
}

async function sendConsoleMessage() {
  var input = document.getElementById('console-input');
  if (!input || state.sending) return;

  var message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = 'auto';

  // Show human turn immediately
  addConsoleTurn('human', message);

  // Show thinking indicator and loading state
  setSendingState(true);
  showThinkingIndicator();

  try {
    var data = await apiPost('/console/send', { message: message });

    removeThinkingIndicator();

    // Update session ID from response
    if (data.sessionId) {
      updateSessionIndicator(data.sessionId);
    }

    // Response may come via WebSocket (console-response event) or
    // directly in the response body
    if (data.result) {
      addConsoleTurn('assistant', data.result);
    }
  } catch (e) {
    removeThinkingIndicator();
    addConsoleTurn('error', 'Error: ' + e.message);
  } finally {
    setSendingState(false);
    input.focus();
  }
}


// --- Console History Load ---

async function loadConsoleHistory() {
  var container = document.getElementById('console-history');

  // Show loading state
  if (container) {
    var welcome = container.querySelector('.console-welcome');
    if (welcome) {
      welcome.innerHTML = '<p>Loading session...</p>';
      welcome.className = 'console-loading';
    }
  }

  try {
    var data = await apiGet('/console/history');

    if (data.sessionId) {
      updateSessionIndicator(data.sessionId);
    }

    if (data.turns && Array.isArray(data.turns) && data.turns.length > 0) {
      // Remove loading state
      if (container) {
        var loading = container.querySelector('.console-loading');
        if (loading) loading.remove();
      }

      for (var i = 0; i < data.turns.length; i++) {
        var turn = data.turns[i];
        addConsoleTurn(turn.role || 'assistant', turn.content || '', turn.ts);
      }
    } else {
      // No history — show welcome
      if (container) {
        var loadingEl = container.querySelector('.console-loading');
        if (loadingEl) {
          loadingEl.className = 'console-welcome';
          loadingEl.innerHTML = '<p>Welcome to HIVE. Type a message to talk to the hive mind.</p>' +
            '<p class="console-welcome-hint">The console is your steering wheel. The feed is your dashboard.</p>';
        }
      }
    }
  } catch (e) {
    // Console history endpoint may not exist yet — that is fine
    console.log('Console history not available:', e.message);
    if (container) {
      var loadingFallback = container.querySelector('.console-loading');
      if (loadingFallback) {
        loadingFallback.className = 'console-welcome';
        loadingFallback.innerHTML = '<p>Welcome to HIVE. Type a message to talk to the hive mind.</p>' +
          '<p class="console-welcome-hint">The console is your steering wheel. The feed is your dashboard.</p>';
      }
    }
  }
}


// --- Session Toolbar Setup ---

function setupSessionToolbar() {
  var newBtn = document.getElementById('new-session-btn');
  var sessionsBtn = document.getElementById('sessions-btn');

  if (newBtn) {
    newBtn.addEventListener('click', function () {
      createNewSession();
    });
  }

  if (sessionsBtn) {
    sessionsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleSessionsDropdown();
    });
  }
}


// --- Agent Dropdown Setup ---

function setupAgentDropdown() {
  var agentsEl = document.getElementById('agent-count');
  if (agentsEl) {
    agentsEl.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleAgentDropdown();
    });
  }
}


// --- Keyboard Shortcuts ---

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function (e) {
    // Ctrl+N (or Cmd+N on Mac): new session
    var modKey = isMac() ? e.metaKey : e.ctrlKey;
    if (modKey && e.key === 'n') {
      e.preventDefault();
      createNewSession();
    }
  });
}


// --- Close dropdowns on outside click ---

function setupGlobalClickHandler() {
  document.addEventListener('click', function () {
    closeAgentDropdown();
    closeSessionsDropdown();
  });
}


// --- Initialization ---

async function init() {
  // Set up console input handler
  setupConsoleInput();

  // Set up session toolbar
  setupSessionToolbar();

  // Set up agent dropdown
  setupAgentDropdown();

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  // Close dropdowns on outside click
  setupGlobalClickHandler();

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Show initial empty feed state
  renderFeedEntries([]);

  // Load initial data from API (non-blocking, graceful on failure)
  refreshStatus();
  refreshFeed();
  refreshAgentOverview();
  loadConsoleHistory();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
