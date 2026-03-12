/* ============================================================
   HIVE Web UI — app.js
   REST client, WebSocket connection, DOM rendering.
   No frameworks. No build step. No dependencies.
   ============================================================ */

// --- State ---

var state = {
  project: null,
  sessionProject: null,
  supervisorStatus: null,
  agentCount: 0,
  agents: [],
  ws: null,
  wsConnected: false,
  wsReconnectDelay: 1000,
  wsMaxReconnectDelay: 30000,
  processLogsRefreshTimer: null,
  feedEntries: [],
  consoleHistory: [],
  consoleStream: null,
  consoleDetailPayloads: [],
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
      scheduleProcessLogsRefresh();
      break;
    case 'board-changed':
    case 'run-changed':
    case 'state-changed':
    case 'run-started':
    case 'run-completed':
    case 'supervisor-tick':
      refreshStatus();
      refreshAgentOverview();
      scheduleProcessLogsRefresh();
      break;
    case 'console-response':
    case 'session-message':
      if (event.data && event.data.content) {
        if (event.data.sessionId && state.sessionId && event.data.sessionId !== state.sessionId) {
          break;
        }
        if (event.project) {
          updateSessionProject(event.project);
        }
        scheduleProcessLogsRefresh();
        removeThinkingIndicator();
        addConsoleTurn(
          event.data.role || 'assistant',
          event.data.content,
          event.data.ts || event.ts,
          event.data.source || null,
          event.data.details || null
        );
      }
      break;
    case 'session-stream':
      if (event.data) {
        if (event.data.sessionId && state.sessionId && event.data.sessionId !== state.sessionId) {
          break;
        }
        if (event.project) {
          updateSessionProject(event.project);
        }
        updateThinkingIndicator(event.data.content || '');
      }
      break;
  }
}


// --- DOM: Feed Panel ---

function classifyFeedStatus(entry) {
  if (!entry) return '';
  var text = ((entry.data && (entry.data.headline || entry.data.raw)) || entry.type || '').toLowerCase();
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
    if (Array.isArray(details)) {
      html += '<div class="feed-entry-details">';
      for (var i = 0; i < details.length; i++) {
        html += '<div>' + escapeHtml(String(details[i])) + '</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="feed-entry-details">' + escapeHtml(String(details)) + '</div>';
    }
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

function getTurnPresentation(role, source) {
  if (role === 'error') {
    return { cssRole: 'error', label: 'error' };
  }

  if (role === 'assistant' && source === 'system') {
    return { cssRole: 'system', label: 'status' };
  }

  return { cssRole: role, label: role };
}

function formatInteger(value) {
  if (value === null || value === undefined || value === '') return '';
  var number = Number(value);
  if (!isFinite(number)) return '';
  return number.toLocaleString('en-US');
}

function buildTokenSummary(details) {
  if (!details) return '';

  var parts = [];
  if (details.inputTokens !== null && details.inputTokens !== undefined) {
    parts.push('in ' + formatInteger(details.inputTokens));
  }
  if (details.outputTokens !== null && details.outputTokens !== undefined) {
    parts.push('out ' + formatInteger(details.outputTokens));
  }
  if (details.cacheCreationInputTokens !== null && details.cacheCreationInputTokens !== undefined) {
    parts.push('cache write ' + formatInteger(details.cacheCreationInputTokens));
  }
  if (details.cacheReadInputTokens !== null && details.cacheReadInputTokens !== undefined) {
    parts.push('cache read ' + formatInteger(details.cacheReadInputTokens));
  }
  if (details.totalTokens !== null && details.totalTokens !== undefined) {
    parts.push('total ' + formatInteger(details.totalTokens));
  }
  return parts.join(' · ');
}

function normalizeStatusNote(note) {
  return (note || '').replace(/\r\n/g, '\n').trim();
}

function pushUniqueNote(notes, note) {
  var normalized = normalizeStatusNote(note);
  if (!normalized) return;
  if (notes.indexOf(normalized) === -1) {
    notes.push(normalized);
  }
}

function mergeTurnDetails(baseDetails, systemTurns) {
  var details = baseDetails ? Object.assign({}, baseDetails) : {};
  var statusNotes = [];
  var baseNotes = details.statusNotes || [];

  for (var i = 0; i < baseNotes.length; i++) {
    pushUniqueNote(statusNotes, baseNotes[i]);
  }

  for (var j = 0; j < systemTurns.length; j++) {
    var systemTurn = systemTurns[j];
    pushUniqueNote(statusNotes, systemTurn.content);

    if (systemTurn.details && systemTurn.details.statusNotes) {
      for (var k = 0; k < systemTurn.details.statusNotes.length; k++) {
        pushUniqueNote(statusNotes, systemTurn.details.statusNotes[k]);
      }
    }
  }

  if (statusNotes.length > 0) {
    details.statusNotes = statusNotes;
  } else if ('statusNotes' in details) {
    delete details.statusNotes;
  }

  return details;
}

function hasTurnDetails(details) {
  if (!details) return false;

  return Boolean(
    details.project ||
    details.runId ||
    details.runtime ||
    details.model ||
    details.authMode ||
    details.durationMs !== null && details.durationMs !== undefined ||
    details.numTurns !== null && details.numTurns !== undefined ||
    details.costUsd !== null && details.costUsd !== undefined ||
    details.inputTokens !== null && details.inputTokens !== undefined ||
    details.outputTokens !== null && details.outputTokens !== undefined ||
    details.totalTokens !== null && details.totalTokens !== undefined ||
    details.board ||
    details.messages ||
    details.runs ||
    details.statusNotes && details.statusNotes.length > 0
  );
}

function summarizeSystemTurn(content) {
  var trimmed = (content || '').trim();
  if (!trimmed) return 'Status update';
  return trimmed.split('\n')[0];
}

function buildStatusDisplayItem(systemTurns) {
  var latestTurn = systemTurns[systemTurns.length - 1];
  return {
    itemType: 'status',
    role: 'assistant',
    source: 'system',
    ts: latestTurn.ts,
    content: summarizeSystemTurn(latestTurn.content),
    fullText: systemTurns.map(function (turn) {
      return normalizeStatusNote(turn.content);
    }).filter(Boolean).join('\n\n'),
    details: mergeTurnDetails(latestTurn.details || null, systemTurns),
  };
}

function buildConsoleDisplayItems(turns) {
  var items = [];
  var pendingSystemTurns = [];

  for (var i = 0; i < turns.length; i++) {
    var turn = turns[i];

    if (turn.role === 'assistant' && turn.source === 'system') {
      pendingSystemTurns.push(turn);
      continue;
    }

    if (turn.role === 'human' && pendingSystemTurns.length > 0) {
      items.push(buildStatusDisplayItem(pendingSystemTurns));
      pendingSystemTurns = [];
    }

    items.push({
      itemType: 'turn',
      role: turn.role,
      source: turn.source || null,
      ts: turn.ts,
      content: turn.content || '',
      details: mergeTurnDetails(turn.details || null, pendingSystemTurns),
    });
    pendingSystemTurns = [];
  }

  if (pendingSystemTurns.length > 0) {
    items.push(buildStatusDisplayItem(pendingSystemTurns));
  }

  return items;
}

function renderDetailSection(title, rows) {
  if (!rows || rows.length === 0) return '';

  var html = '<section class="turn-detail-section">';
  html += '<div class="turn-detail-section-title">' + escapeHtml(title) + '</div>';
  html += '<div class="turn-detail-section-body">';
  for (var i = 0; i < rows.length; i++) {
    html += '<div class="turn-detail-row">' + escapeHtml(rows[i]) + '</div>';
  }
  html += '</div></section>';
  return html;
}

function buildDetailPayload(item) {
  return {
    title: item.itemType === 'status' ? 'Status Detail' : 'Reply Detail',
    content: item.content || '',
    fullText: item.fullText || null,
    details: item.details || null,
  };
}

function registerDetailPayload(item) {
  if (!hasTurnDetails(item.details) && !item.fullText) return null;
  var index = state.consoleDetailPayloads.length;
  state.consoleDetailPayloads.push(buildDetailPayload(item));
  return index;
}

function renderDetailChip(item) {
  var index = registerDetailPayload(item);
  if (index === null) return '';

  return '<button class="turn-detail-chip" type="button" data-detail-index="' + index + '">' +
    '<span class="turn-detail-chip-label">detail</span>' +
    '</button>';
}

function renderConsoleItem(item) {
  var presentation = getTurnPresentation(item.role, item.source);
  var classes = ['turn', 'turn-' + presentation.cssRole];
  if (item.itemType === 'status') {
    classes.push('turn-collapsed-status');
  }
  if (item.itemType === 'draft') {
    classes.push('turn-draft');
  }

  var html = '<div class="' + classes.join(' ') + '">';
  html += '<div class="turn-header">';
  html += '<div class="turn-role">' + escapeHtml(presentation.label) + '</div>';
  html += '<div class="turn-header-right">';
  html += renderDetailChip(item);
  html += '<span class="turn-time">' + escapeHtml(formatTime(item.ts || nowISO())) + '</span>';
  html += '</div></div>';

  if (item.itemType === 'draft' && !item.content) {
    html += '<div class="turn-content"><span class="thinking-dots">';
    html += '<span></span><span></span><span></span>';
    html += '</span></div>';
  } else {
    html += '<div class="turn-content">' + escapeHtml(item.content || '') + '</div>';
  }

  html += '</div>';
  return html;
}

function renderConsoleHistory() {
  var container = document.getElementById('console-history');
  if (!container) return;

  var items = buildConsoleDisplayItems(state.consoleHistory);
  state.consoleDetailPayloads = [];

  if (state.consoleStream) {
    items.push({
      itemType: 'draft',
      role: 'assistant',
      source: 'system',
      ts: state.consoleStream.ts || nowISO(),
      content: state.consoleStream.content || '',
      details: null,
    });
  }

  if (items.length === 0) {
    container.innerHTML = '<div class="console-welcome">' +
      '<p>Speak to the swarm.</p>' +
      '<p class="console-welcome-hint">Console steers. Feed watches.</p>' +
      '</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < items.length; i++) {
    html += renderConsoleItem(items[i]);
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function setConsoleHistory(turns) {
  state.consoleHistory = Array.isArray(turns) ? turns.slice() : [];
  state.consoleStream = null;
  renderConsoleHistory();
}

function addConsoleTurn(role, content, timestamp, source, details) {
  state.consoleHistory.push({
    role: role,
    source: source || null,
    content: content || '',
    ts: timestamp || nowISO(),
    details: details || null,
  });
  renderConsoleHistory();
}

function showThinkingIndicator() {
  state.consoleStream = {
    ts: nowISO(),
    content: '',
  };
  renderConsoleHistory();
}

function updateThinkingIndicator(content) {
  state.consoleStream = {
    ts: (state.consoleStream && state.consoleStream.ts) || nowISO(),
    content: content || '',
  };
  renderConsoleHistory();
}

function removeThinkingIndicator() {
  if (!state.consoleStream) return;
  state.consoleStream = null;
  renderConsoleHistory();
}

function clearConsoleHistory() {
  state.consoleHistory = [];
  state.consoleStream = null;
  renderConsoleHistory();
}

function openConsoleDetailModal(index) {
  var payload = state.consoleDetailPayloads[index];
  var modal = document.getElementById('turn-detail-modal');
  var title = document.getElementById('turn-detail-title');
  var body = document.getElementById('turn-detail-body');

  if (!payload || !modal || !title || !body) return;

  var details = payload.details || {};
  var usageRows = [];
  var contextRows = [];
  var statusRows = [];
  var tokenSummary = buildTokenSummary(details);

  if (details.runtime) usageRows.push('runtime: ' + details.runtime);
  if (details.model) usageRows.push('model: ' + details.model);
  if (details.authMode) usageRows.push('auth: ' + details.authMode);
  if (details.durationMs !== null && details.durationMs !== undefined) {
    usageRows.push('duration: ' + (Number(details.durationMs) / 1000).toFixed(1) + 's');
  }
  if (details.numTurns !== null && details.numTurns !== undefined) {
    usageRows.push('turns: ' + formatInteger(details.numTurns));
  }
  if (tokenSummary) usageRows.push('tokens: ' + tokenSummary);
  if (details.costUsd !== null && details.costUsd !== undefined) {
    usageRows.push('cost equivalent: $' + Number(details.costUsd).toFixed(4));
  }

  if (details.project) contextRows.push('project: ' + details.project);
  if (details.runId) contextRows.push('run: ' + details.runId);
  if (details.board) {
    contextRows.push(
      'board: ' +
      formatInteger(details.board.taskCount) + ' total · ' +
      formatInteger(details.board.activeCount) + ' active · ' +
      formatInteger(details.board.waitingCount) + ' waiting · ' +
      formatInteger(details.board.doneCount) + ' done'
    );
    if (details.board.blockers && details.board.blockers.length > 0) {
      contextRows.push('blockers: ' + details.board.blockers.join(' | '));
    }
  }
  if (details.messages) {
    contextRows.push(
      'messages: ' +
      formatInteger(details.messages.openCount) + ' open · ' +
      formatInteger(details.messages.pendingHumanMessages) + ' waiting on human · ' +
      formatInteger(details.messages.pendingHumanReplies) + ' human replies pending'
    );
  }
  if (details.runs) {
    contextRows.push('active runs: ' + formatInteger(details.runs.activeCount));
  }

  if (payload.fullText) {
    statusRows.push(payload.fullText);
  }
  if (details.statusNotes) {
    for (var i = 0; i < details.statusNotes.length; i++) {
      pushUniqueNote(statusRows, details.statusNotes[i]);
    }
  }

  title.textContent = payload.title;

  var html = '';
  if (payload.content) {
    html += '<section class="turn-detail-section">';
    html += '<div class="turn-detail-section-title">Visible Message</div>';
    html += '<pre class="turn-detail-pre">' + escapeHtml(payload.content) + '</pre>';
    html += '</section>';
  }
  html += renderDetailSection('Usage', usageRows);
  html += renderDetailSection('Context', contextRows);
  if (statusRows.length > 0) {
    html += '<section class="turn-detail-section">';
    html += '<div class="turn-detail-section-title">Hidden Ops</div>';
    html += '<div class="turn-detail-section-body">';
    for (var j = 0; j < statusRows.length; j++) {
      html += '<pre class="turn-detail-pre">' + escapeHtml(statusRows[j]) + '</pre>';
    }
    html += '</div></section>';
  }

  body.innerHTML = html || '<div class="turn-detail-empty">No extra detail recorded for this turn.</div>';
  modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeConsoleDetailModal() {
  var modal = document.getElementById('turn-detail-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function setupConsoleDetailModal() {
  var container = document.getElementById('console-history');
  var modal = document.getElementById('turn-detail-modal');
  var backdrop = document.getElementById('turn-detail-backdrop');
  var closeBtn = document.getElementById('turn-detail-close');

  if (container) {
    container.addEventListener('click', function (event) {
      var button = event.target && event.target.closest
        ? event.target.closest('[data-detail-index]')
        : null;
      if (!button) return;
      var index = Number(button.getAttribute('data-detail-index'));
      if (!isNaN(index)) {
        openConsoleDetailModal(index);
      }
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', closeConsoleDetailModal);
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', closeConsoleDetailModal);
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && modal && !modal.hidden) {
      closeConsoleDetailModal();
    }
  });
}


// --- Session Management ---

function renderProjectName() {
  var projectEl = document.getElementById('project-name');
  if (!projectEl) return;
  projectEl.textContent = state.sessionProject || state.project || '\u2014';
}

function updateSessionProject(project) {
  state.sessionProject = project || null;
  renderProjectName();
  scheduleProcessLogsRefresh(0);
}

function updateSessionIndicator(sessionId, project) {
  state.sessionId = sessionId;
  if (project !== undefined) {
    updateSessionProject(project);
  } else if (!sessionId) {
    updateSessionProject(null);
  }
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
    updateSessionIndicator(data.sessionId, data.project);
    clearConsoleHistory();
  } catch (e) {
    console.error('Failed to create new session:', e);
    addConsoleTurn('error', 'Failed to create new session: ' + e.message);
  }
}

async function loadSession(sessionId) {
  try {
    var data = await apiGet('/sessions/' + sessionId);

    updateSessionIndicator(
      sessionId,
      (data.session && (data.session.currentProject || data.session.project)) || null
    );

    setConsoleHistory(data.turns || []);

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
      var project = session.currentProject || session.project || '';
      item.innerHTML =
        '<div class="sessions-dropdown-item-id">' + escapeHtml(session.sessionId) + '</div>' +
        '<div class="sessions-dropdown-item-meta">' +
        escapeHtml(started) + ' \u00b7 ' + turns + ' turn' + (turns !== 1 ? 's' : '') +
        (project ? ' \u00b7 ' + escapeHtml(project) : '') +
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

  if (data.project) {
    state.project = data.project;
  }
  renderProjectName();
  scheduleProcessLogsRefresh();

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


// --- Process Logs ---

function scheduleProcessLogsRefresh(delay) {
  if (state.processLogsRefreshTimer) {
    clearTimeout(state.processLogsRefreshTimer);
  }

  state.processLogsRefreshTimer = setTimeout(function () {
    state.processLogsRefreshTimer = null;
    refreshProcessLogs();
  }, typeof delay === 'number' ? delay : 200);
}

function renderProcessLogBlock(title, meta, tailLines) {
  var tail = tailLines && tailLines.length > 0
    ? escapeHtml(tailLines.join('\n'))
    : '<span class="process-log-empty-line">(no output yet)</span>';

  return '<div class="process-log-block">' +
    '<div class="process-log-title">' + escapeHtml(title) + '</div>' +
    '<div class="process-log-meta">' + escapeHtml(meta) + '</div>' +
    '<pre class="process-log-tail">' + tail + '</pre>' +
    '</div>';
}

function renderProcessLogs(data) {
  var container = document.getElementById('process-logs-content');
  if (!container) return;

  if (!data || !data.project) {
    container.innerHTML = '<div class="process-logs-empty">No project in focus yet. Start a session or switch project focus.</div>';
    return;
  }

  var html = '';

  if (data.supervisor) {
    var supervisorMeta = 'status ' + (data.supervisor.status || 'unknown');
    if (data.supervisor.pid) {
      supervisorMeta += ' · pid ' + data.supervisor.pid;
    }
    html += renderProcessLogBlock(
      'Supervisor · ' + data.project,
      supervisorMeta,
      data.supervisor.tail || []
    );
  }

  if (data.runs && Array.isArray(data.runs)) {
    for (var i = 0; i < data.runs.length; i++) {
      var run = data.runs[i];
      var meta = (run.status || 'active') + ' · ' + (run.runId || '');
      if (run.pid) {
        meta += ' · pid ' + run.pid;
      }
      html += renderProcessLogBlock(
        (run.agentId || 'agent') + ' · ' + data.project,
        meta,
        run.tail || []
      );
    }
  }

  if (!html) {
    container.innerHTML = '<div class="process-logs-empty">No active supervisor or run logs for ' + escapeHtml(data.project) + '.</div>';
    return;
  }

  container.innerHTML = html;
}

async function refreshProcessLogs() {
  var project = state.sessionProject || state.project;
  var path = '/process-logs';
  if (project) {
    path += '?project=' + encodeURIComponent(project);
  }

  try {
    var data = await apiGet(path);
    renderProcessLogs(data);
  } catch (e) {
    console.error('Process logs refresh failed:', e);
    var container = document.getElementById('process-logs-content');
    if (container) {
      container.innerHTML = '<div class="process-logs-empty">Failed to load process logs.</div>';
    }
  }
}

function setupProcessLogs() {
  var btn = document.getElementById('process-logs-refresh');
  if (btn) {
    btn.addEventListener('click', function () {
      refreshProcessLogs();
    });
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
    renderProjectName();
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

    // Update session ID from response
    if (data.sessionId) {
      updateSessionIndicator(data.sessionId, data.project);
    }

    // Response may come via WebSocket (console-response event) or
    // directly in the response body
    if (data.result) {
      removeThinkingIndicator();
      addConsoleTurn('assistant', data.result, null, data.resultSource || 'system', data.resultDetails || null);
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

  if (container) {
    container.innerHTML = '<div class="console-loading">Loading session...</div>';
  }

  try {
    var data = await apiGet('/console/history');

    if (data.sessionId || data.project === null) {
      updateSessionIndicator(data.sessionId, data.project);
    }

    if (data.turns && Array.isArray(data.turns) && data.turns.length > 0) {
      setConsoleHistory(data.turns);
    } else {
      clearConsoleHistory();
    }
  } catch (e) {
    // Console history endpoint may not exist yet — that is fine
    console.log('Console history not available:', e.message);
    clearConsoleHistory();
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


// --- Supervisor Restart ---

async function restartSupervisor() {
  var btn = document.getElementById('restart-btn');
  if (btn) btn.disabled = true;

  try {
    var data = await apiPost('/supervisor/restart', {});
    var msg = (data && data.message) || 'Supervisor restarted';
    addConsoleTurn('assistant', msg, null, 'system');
    refreshStatus();
    refreshAgentOverview();
  } catch (e) {
    addConsoleTurn('error', 'Restart failed: ' + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setupRestartButton() {
  var btn = document.getElementById('restart-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      restartSupervisor();
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

  // Set up restart button
  setupRestartButton();

  // Set up process logs panel
  setupProcessLogs();

  // Set up console detail modal
  setupConsoleDetailModal();

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  // Close dropdowns on outside click
  setupGlobalClickHandler();

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Show initial empty feed state
  renderFeedEntries([]);
  renderProcessLogs(null);

  // Load initial data from API (non-blocking, graceful on failure)
  refreshStatus();
  refreshFeed();
  refreshAgentOverview();
  refreshProcessLogs();
  loadConsoleHistory();

  setInterval(function () {
    refreshProcessLogs();
  }, 2500);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
