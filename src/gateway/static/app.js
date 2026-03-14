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
  liveRefreshTimer: null,
  queueRefreshTimer: null,
  timelineRefreshTimer: null,
  feedEntries: [],
  consoleHistory: [],
  consoleStream: null,
  consoleDetailPayloads: [],
  consoleExpanded: {},
  consoleView: 'conversation',
  sessionId: null,
  pendingSends: 0,
  liveSnapshot: null,
  processLogsSnapshot: null,
  healthSnapshot: null,
  queueSnapshot: null,
  timelineItems: [],
  railTab: 'live',
  pulsesCollapsed: true,
  processLogsFocus: null,
  processLogsStickToBottom: true,
  processLogsRefreshTimer: null,
  agentSignals: {},
  notificationsPrimed: false,
  toastSeenKeys: {},
  toasts: [],
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

function truncateText(text, max) {
  if (!text) return '';
  var normalized = String(text).replace(/\s+/g, ' ').trim();
  var limit = typeof max === 'number' ? max : 160;
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, limit - 1).trimEnd() + '\u2026';
}

function truncateMultilineText(text, max) {
  if (!text) return '';
  var normalized = String(text).replace(/\r\n/g, '\n').trim();
  var limit = typeof max === 'number' ? max : 360;
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, limit - 1).trimEnd() + '\u2026';
}

function normalizeMultilineText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function splitDisplayLines(text) {
  var normalized = normalizeMultilineText(text);
  if (!normalized) return [];
  return normalized.split('\n').map(function (line) {
    return line.trimEnd();
  }).filter(function (line) {
    return line.trim().length > 0;
  });
}

function formatRelativeAge(iso) {
  if (!iso) return '';

  var then = new Date(iso).getTime();
  if (!isFinite(then)) return '';

  var delta = Math.max(0, Date.now() - then);
  var seconds = Math.floor(delta / 1000);
  if (seconds < 60) return seconds + 's ago';

  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';

  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';

  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

function formatMoment(iso) {
  var time = formatTime(iso);
  var age = formatRelativeAge(iso);
  if (time && age) return time + ' \u00b7 ' + age;
  return time || age || '';
}

function countLabel(count, singular, plural) {
  return count + ' ' + (count === 1 ? singular : (plural || singular + 's'));
}

function joinMeta(parts) {
  return parts.filter(Boolean).join(' \u00b7 ');
}

function toneClass(base, tone) {
  return base + ' ' + base + '--' + (tone || 'info');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function toneFromStatus(status) {
  if (status === 'failed' || status === 'error' || status === 'cancelled') {
    return 'error';
  }
  if (status === 'active' || status === 'running') {
    return 'success';
  }
  if (status === 'starting') {
    return 'warning';
  }
  return 'info';
}

function buildApiPath(basePath, project, params) {
  var search = new URLSearchParams();
  if (project) {
    search.set('project', project);
  }
  if (params) {
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var value = params[key];
      if (value === null || value === undefined || value === '') continue;
      search.set(key, String(value));
    }
  }

  var query = search.toString();
  return query ? basePath + '?' + query : basePath;
}

function parseFileTarget(target) {
  if (!target || target[0] !== '/') return null;

  var normalized = String(target).trim();
  var line = null;
  var fragmentIndex = normalized.indexOf('#L');

  if (fragmentIndex !== -1) {
    var fragment = normalized.slice(fragmentIndex + 2);
    normalized = normalized.slice(0, fragmentIndex);
    var match = fragment.match(/^(\d+)/);
    if (match) {
      line = match[1];
    }
  }

  return {
    path: normalized,
    line: line,
  };
}

function buildMarkdownHref(target) {
  if (!target) return null;

  if (/^https?:\/\//i.test(target)) {
    return target;
  }

  var fileTarget = parseFileTarget(target);
  if (!fileTarget) {
    return null;
  }

  return buildApiPath('/file', null, {
    path: fileTarget.path,
    line: fileTarget.line,
  });
}

function buildPreviewHref(path, line) {
  return buildApiPath('/file', null, {
    path: path,
    line: line,
  });
}

function renderInlineText(text) {
  var source = String(text || '');
  var html = '';
  var lastIndex = 0;
  var markdownLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  var match;

  while ((match = markdownLinkPattern.exec(source)) !== null) {
    html += escapeHtml(source.slice(lastIndex, match.index));
    var label = match[1];
    var target = match[2].trim();
    var href = buildMarkdownHref(target);
    var fileTarget = parseFileTarget(target);

    if (href) {
      var attrs = 'class="turn-link" href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer"';
      if (fileTarget) {
        attrs += ' data-open-path="' + escapeAttr(fileTarget.path) + '"';
        if (fileTarget.line) {
          attrs += ' data-open-line="' + escapeAttr(fileTarget.line) + '"';
        }
      }

      html += '<a ' + attrs + '>' +
        escapeHtml(label) +
        '</a>';
    } else {
      html += escapeHtml(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  html += escapeHtml(source.slice(lastIndex));
  return html;
}

function renderRichText(text) {
  var normalized = String(text || '').replace(/\r\n/g, '\n');
  var blocks = normalized.split(/\n{2,}/);
  var html = '';

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    if (!block.trim()) continue;
    var lines = block.split('\n');
    var renderedLines = [];

    for (var j = 0; j < lines.length; j++) {
      renderedLines.push(renderInlineText(lines[j]));
    }

    html += '<p class="turn-paragraph">' + renderedLines.join('<br>') + '</p>';
  }

  return html || '<p class="turn-paragraph"></p>';
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
      scheduleOperationsRefresh(150);
      break;
    case 'board-changed':
    case 'message-changed':
    case 'run-changed':
    case 'state-changed':
    case 'run-started':
    case 'run-completed':
    case 'supervisor-tick':
      refreshStatus();
      scheduleOperationsRefresh(150);
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
        removeThinkingIndicator();
        addConsoleTurn(
          event.data.role || 'assistant',
          event.data.content,
          event.data.ts || event.ts,
          event.data.source || null,
          event.data.details || null
        );
      }
      scheduleOperationsRefresh(100);
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
      scheduleLiveRefresh(100);
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

function getConsoleItemKey(item, index) {
  return [
    item.itemType || 'turn',
    item.role || '',
    item.source || '',
    item.ts || '',
    index,
  ].join(':');
}

function isConversationOnlyItem(item) {
  return item.itemType === 'status' || item.itemType === 'draft' || item.source === 'system';
}

function getConsoleItemSourceText(item) {
  if (item.itemType === 'status' && item.fullText) {
    return item.fullText;
  }

  return item.content || '';
}

function shouldCollapseConsoleItem(item) {
  return item.itemType === 'draft' || item.itemType === 'status' || item.source === 'system';
}

function shouldPreferLatestPreview(item) {
  return item.itemType === 'draft' || item.itemType === 'status' || item.source === 'system';
}

function buildCollapsedConsolePreview(item) {
  if (!shouldCollapseConsoleItem(item)) {
    return null;
  }

  var sourceText = getConsoleItemSourceText(item);
  var lineLimit = item.itemType === 'draft' ? 5 : 4;
  var charLimit = item.itemType === 'draft' ? 520 : 420;
  var lines = splitDisplayLines(sourceText);
  var normalized = normalizeMultilineText(sourceText);
  var truncatedByLines = lines.length > lineLimit;
  var truncatedByChars = normalized.length > charLimit;

  if (!truncatedByLines && !truncatedByChars) {
    return null;
  }

  var preferLatest = shouldPreferLatestPreview(item);
  var previewLines = truncatedByLines
    ? (preferLatest ? lines.slice(-lineLimit) : lines.slice(0, lineLimit))
    : lines.slice();
  var previewText = previewLines.join('\n');

  if (previewText.length > charLimit) {
    previewText = previewText.slice(0, charLimit - 1).trimEnd() + '\u2026';
  }

  return {
    previewText: previewText,
    totalLines: lines.length || 1,
    shownLines: previewLines.length || 1,
    preferLatest: preferLatest,
  };
}

function getConsoleCollapseMeta(preview) {
  if (!preview) return '';
  var edge = preview.preferLatest ? 'latest' : 'first';
  return 'Showing ' + edge + ' ' + countLabel(preview.shownLines, 'line') + ' of ' + countLabel(preview.totalLines, 'line');
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

function renderConsoleExpandChip(item) {
  var preview = buildCollapsedConsolePreview(item);
  if (!preview) return '';

  var expanded = Boolean(state.consoleExpanded[item.consoleKey]);
  var label = expanded ? 'collapse' : 'expand';

  return '<button class="turn-expand-chip" type="button" data-console-expand="' + escapeAttr(item.consoleKey) + '">' +
    '<span class="turn-expand-chip-label">' + escapeHtml(label) + '</span>' +
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
  var preview = buildCollapsedConsolePreview(item);
  var expanded = preview ? Boolean(state.consoleExpanded[item.consoleKey]) : false;
  if (preview && !expanded) {
    classes.push('turn-collapsed-preview');
  }

  var html = '<div class="' + classes.join(' ') + '">';
  html += '<div class="turn-header">';
  html += '<div class="turn-role">' + escapeHtml(presentation.label) + '</div>';
  html += '<div class="turn-header-right">';
  html += renderConsoleExpandChip(item);
  html += renderDetailChip(item);
  html += '<span class="turn-time">' + escapeHtml(formatTime(item.ts || nowISO())) + '</span>';
  html += '</div></div>';

  if (item.itemType === 'draft' && !item.content) {
    html += '<div class="turn-content"><span class="thinking-dots">';
    html += '<span></span><span></span><span></span>';
    html += '</span></div>';
  } else {
    html += '<div class="turn-content">' + renderRichText(preview && !expanded ? preview.previewText : getConsoleItemSourceText(item)) + '</div>';
    if (preview) {
      html += '<div class="turn-collapse-meta">';
      html += '<span class="turn-collapse-note">' + escapeHtml(getConsoleCollapseMeta(preview)) + '</span>';
      html += '<button class="turn-collapse-toggle" type="button" data-console-expand="' + escapeAttr(item.consoleKey) + '">' +
        escapeHtml(expanded ? 'Show less' : 'Show more') +
        '</button>';
      html += '</div>';
    }
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

  for (var idx = 0; idx < items.length; idx++) {
    items[idx].consoleKey = getConsoleItemKey(items[idx], idx);
  }

  var hiddenCount = 0;
  if (state.consoleView === 'conversation') {
    items = items.filter(function (item) {
      var hidden = isConversationOnlyItem(item);
      if (hidden) hiddenCount += 1;
      return !hidden;
    });
  }

  if (items.length === 0) {
    if (hiddenCount > 0) {
      container.innerHTML = '<div class="console-filter-empty">' +
        '<p>The steward is working in the background.</p>' +
        '<p class="console-filter-empty-hint">' + escapeHtml(countLabel(hiddenCount, 'internal update')) + ' hidden in Conversation view.</p>' +
        '<button class="console-filter-link" type="button" data-console-view="all">Show full session</button>' +
        '</div>';
    } else {
      container.innerHTML = '<div class="console-welcome">' +
        '<p>Talk to the steward.</p>' +
        '<p class="console-welcome-hint">The head stays here. Delegation runs in the background.</p>' +
        '</div>';
    }
    return;
  }

  var html = '';
  if (hiddenCount > 0) {
    html += '<div class="console-filter-banner">' +
      '<span class="console-filter-banner-copy">' + escapeHtml(countLabel(hiddenCount, 'internal update')) + ' hidden in Conversation view.</span>' +
      '<button class="console-filter-link" type="button" data-console-view="all">Show full session</button>' +
      '</div>';
  }
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
  state.consoleExpanded = {};
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

async function requestOpenLocalPath(path, line) {
  if (!path) return;

  try {
    await apiPost('/open', {
      path: path,
      line: line || null,
    });
  } catch (e) {
    console.error('Open path request failed:', e);
    window.open(buildPreviewHref(path, line || null), '_blank', 'noopener,noreferrer');
  }
}

function setupConsoleDetailModal() {
  var container = document.getElementById('console-history');
  var modal = document.getElementById('turn-detail-modal');
  var backdrop = document.getElementById('turn-detail-backdrop');
  var closeBtn = document.getElementById('turn-detail-close');

  if (container) {
    container.addEventListener('click', function (event) {
      var viewButton = event.target && event.target.closest
        ? event.target.closest('[data-console-view]')
        : null;
      if (viewButton) {
        setConsoleView(viewButton.getAttribute('data-console-view') || 'conversation');
        return;
      }

      var link = event.target && event.target.closest
        ? event.target.closest('a[data-open-path]')
        : null;
      if (link) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        requestOpenLocalPath(
          link.getAttribute('data-open-path') || '',
          link.getAttribute('data-open-line') || null
        );
        return;
      }

      var expandButton = event.target && event.target.closest
        ? event.target.closest('[data-console-expand]')
        : null;
      if (expandButton) {
        toggleConsoleItemExpanded(expandButton.getAttribute('data-console-expand') || '');
        return;
      }

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

function resetProcessLogFocus(clearSnapshot) {
  state.processLogsFocus = null;
  state.processLogsStickToBottom = true;
  if (clearSnapshot) {
    state.processLogsSnapshot = null;
  }
}

function renderProjectName() {
  var projectEl = document.getElementById('project-name');
  if (!projectEl) return;
  projectEl.textContent = state.sessionProject || state.project || '\u2014';
}

function updateSessionProject(project) {
  var nextProject = project || null;
  if (state.sessionProject !== nextProject) {
    resetProcessLogFocus(true);
  }
  state.sessionProject = nextProject;
  renderProjectName();
  renderProcessLogs(state.processLogsSnapshot);
  scheduleOperationsRefresh(0);
}

function updateSessionIndicator(sessionId, project) {
  if (state.sessionId !== sessionId) {
    state.consoleExpanded = {};
    state.pulsesCollapsed = true;
    resetProcessLogFocus(true);
    state.notificationsPrimed = false;
    state.toastSeenKeys = {};
    state.toasts = [];
  }
  state.sessionId = sessionId;
  if (project !== undefined) {
    updateSessionProject(project);
  } else if (!sessionId) {
    updateSessionProject(null);
  }
  renderLeadershipSurface();
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
    scheduleOperationsRefresh(0);
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
    scheduleOperationsRefresh(0);

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


// --- Operations Rail ---

function updateAgentOverview(agents) {
  state.agents = Array.isArray(agents) ? agents.slice() : [];
  state.agentCount = state.agents.length;

  var labelEl = document.querySelector('.topbar-agents-label');
  if (labelEl) {
    labelEl.textContent = state.agents.length > 0
      ? countLabel(state.agents.length, 'live agent')
      : '\u2014';
  }

  var list = document.getElementById('agent-dropdown-list');
  if (!list) return;

  if (state.agents.length === 0) {
    list.innerHTML = '<div class="agent-dropdown-empty">No active agents</div>';
    return;
  }

  list.innerHTML = '';

  for (var i = 0; i < state.agents.length; i++) {
    var agent = state.agents[i];
    var health = findAgentHealth(state.healthSnapshot, agent);
    var item = document.createElement('div');
    item.className = 'agent-dropdown-item';
    item.innerHTML =
      '<span class="agent-dropdown-name">' + escapeHtml(agent.displayName || agent.agentId || 'agent') + '</span>' +
      '<span class="agent-dropdown-persona">' + escapeHtml(agent.persona || '') + '</span>' +
      '<span class="agent-dropdown-health agent-dropdown-health--' + escapeAttr(health ? health.label : 'working') + '">' +
        escapeHtml((health ? health.icon + ' ' + health.label : '· working')) +
      '</span>' +
      '<span class="agent-dropdown-runtime">' + escapeHtml(agent.runtime || '') + '</span>' +
      '<span class="agent-dropdown-age">' + escapeHtml(formatRelativeAge(agent.started)) + '</span>';
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

function refreshAgentOverview() {
  return refreshLiveSnapshot();
}

function setRailTab(tab) {
  state.railTab = tab || 'live';

  var buttons = document.querySelectorAll('[data-rail-tab]');
  for (var i = 0; i < buttons.length; i++) {
    var button = buttons[i];
    var active = button.getAttribute('data-rail-tab') === state.railTab;
    button.classList.toggle('rail-tab--active', active);
  }

  var panels = document.querySelectorAll('[data-rail-panel]');
  for (var j = 0; j < panels.length; j++) {
    var panel = panels[j];
    var visible = panel.getAttribute('data-rail-panel') === state.railTab;
    panel.classList.toggle('rail-panel--active', visible);
  }
}

function setupRailTabs() {
  var buttons = document.querySelectorAll('[data-rail-tab]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      var tab = this.getAttribute('data-rail-tab') || 'live';
      setRailTab(tab);
    });
  }
}

function scheduleLiveRefresh(delay) {
  if (state.liveRefreshTimer) {
    clearTimeout(state.liveRefreshTimer);
  }

  state.liveRefreshTimer = setTimeout(function () {
    state.liveRefreshTimer = null;
    refreshLiveSnapshot();
  }, typeof delay === 'number' ? delay : 160);
}

function scheduleQueueRefresh(delay) {
  if (state.queueRefreshTimer) {
    clearTimeout(state.queueRefreshTimer);
  }

  state.queueRefreshTimer = setTimeout(function () {
    state.queueRefreshTimer = null;
    refreshQueueSnapshot();
  }, typeof delay === 'number' ? delay : 220);
}

function scheduleTimelineRefresh(delay) {
  if (state.timelineRefreshTimer) {
    clearTimeout(state.timelineRefreshTimer);
  }

  state.timelineRefreshTimer = setTimeout(function () {
    state.timelineRefreshTimer = null;
    refreshTimeline();
  }, typeof delay === 'number' ? delay : 280);
}

function scheduleProcessLogsRefresh(delay) {
  if (state.processLogsRefreshTimer) {
    clearTimeout(state.processLogsRefreshTimer);
  }

  state.processLogsRefreshTimer = setTimeout(function () {
    state.processLogsRefreshTimer = null;
    refreshProcessLogs();
  }, typeof delay === 'number' ? delay : 200);
}

function scheduleOperationsRefresh(delay) {
  var base = typeof delay === 'number' ? delay : 180;
  scheduleLiveRefresh(base);
  scheduleProcessLogsRefresh(base + 30);
  scheduleQueueRefresh(base + 90);
  scheduleTimelineRefresh(base + 150);
}

function getProjectFocus() {
  return state.sessionProject || state.project || null;
}

function getMinutesSince(iso) {
  if (!iso) return 0;
  var then = new Date(iso).getTime();
  if (!isFinite(then)) return 0;
  return Math.max(0, (Date.now() - then) / 60000);
}

function getAgentKey(agent) {
  return (agent && (agent.runId || agent.agentId || agent.displayName)) || '';
}

function buildAgentOutputFingerprint(agent) {
  if (!agent) return '';

  var segments = [];
  if (Array.isArray(agent.tail) && agent.tail.length > 0) {
    segments.push(agent.tail.join('\n'));
  }
  if (agent.latestOutput) {
    segments.push(agent.latestOutput);
  }

  return normalizeMultilineText(segments.join('\n'));
}

function updateAgentSignals(agents) {
  var nextSignals = {};
  var now = nowISO();

  for (var i = 0; i < (agents || []).length; i++) {
    var agent = agents[i];
    var key = getAgentKey(agent);
    if (!key) continue;

    var fingerprint = buildAgentOutputFingerprint(agent);
    var previous = state.agentSignals[key];
    var changed = !previous || previous.fingerprint !== fingerprint;
    var hadOutput = previous ? previous.outputSeen : false;
    var outputSeen = hadOutput || Boolean(fingerprint);
    var lastChangedAt;

    if (changed) {
      if (fingerprint) {
        lastChangedAt = now;
      } else {
        lastChangedAt = agent.started || now;
      }
    } else {
      lastChangedAt = previous.lastChangedAt || agent.started || now;
    }

    nextSignals[key] = {
      fingerprint: fingerprint,
      lastChangedAt: lastChangedAt,
      changeCount: changed
        ? ((previous && previous.changeCount) || 0) + (fingerprint ? 1 : 0)
        : ((previous && previous.changeCount) || 0),
      outputSeen: outputSeen,
    };
  }

  state.agentSignals = nextSignals;
}

function countPatternMatches(text, pattern) {
  if (!text) return 0;
  var matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function healthTone(level) {
  if (level === 'cruising') return 'success';
  if (level === 'struggling') return 'warning';
  if (level === 'stuck') return 'error';
  return 'info';
}

function healthIcon(level) {
  if (level === 'cruising') return '●';
  if (level === 'struggling') return '▲';
  if (level === 'stuck') return '■';
  return '·';
}

function formatHealthLevel(level) {
  return level || 'working';
}

function buildAgentHealth(agent) {
  var key = getAgentKey(agent);
  var signal = key ? state.agentSignals[key] : null;
  var text = buildAgentOutputFingerprint(agent).toLowerCase();
  var ageMinutes = getMinutesSince(agent.started);
  var staleMinutes = getMinutesSince(signal ? signal.lastChangedAt : agent.started);
  var outputSeen = signal ? signal.outputSeen : Boolean(text);
  var changeCount = signal ? signal.changeCount : 0;
  var blockedMatches = countPatternMatches(
    text,
    /\b(blocked|stuck|waiting on|needs human|needs your|approval required|cannot proceed|can't proceed|permission denied)\b/g,
  );
  var struggleMatches = countPatternMatches(
    text,
    /\b(error|failed|retry|retrying|exception|timeout|timed out|not found|unable|cannot|can't|conflict|warning|failing|fixing|investigating)\b/g,
  );
  var progressMatches = countPatternMatches(
    text,
    /\b(completed|updated|wrote|fixed|verified|created|launched|running|working|finished|done|passed|clean|resolved)\b/g,
  );
  var level = 'working';
  var reason = 'Work is moving normally.';

  if (agent.status === 'failed' || agent.status === 'error' || agent.status === 'cancelled') {
    level = 'stuck';
    reason = 'This run is no longer healthy and likely needs intervention.';
  } else if (blockedMatches > 0 || ((staleMinutes >= 14 && ageMinutes >= 15) || (!outputSeen && ageMinutes >= 12))) {
    level = 'stuck';
    reason = blockedMatches > 0
      ? 'The latest output reads like a blocker or a wait state.'
      : 'No meaningful visible movement for ' + Math.round(staleMinutes) + 'm.';
  } else if (struggleMatches > 0 || (staleMinutes >= 7 && ageMinutes >= 9)) {
    level = 'struggling';
    reason = struggleMatches > 0
      ? 'Retries, errors, or warnings are showing up in the recent output.'
      : 'Progress has gone quiet for ' + Math.round(staleMinutes) + 'm.';
  } else if ((progressMatches > 0 && staleMinutes <= 3) || (changeCount >= 3 && staleMinutes <= 4) || (outputSeen && ageMinutes <= 4)) {
    level = 'cruising';
    reason = 'Recent output suggests steady forward progress.';
  }

  return {
    key: key,
    level: level,
    tone: healthTone(level),
    icon: healthIcon(level),
    label: formatHealthLevel(level),
    summary: reason,
    ageMinutes: ageMinutes,
    staleMinutes: staleMinutes,
    ageLabel: formatRelativeAge(agent.started),
    staleLabel: Math.round(staleMinutes) + 'm quiet',
    outputSeen: outputSeen,
    changeCount: changeCount,
  };
}

function buildHealthSnapshot(liveSnapshot) {
  var agents = liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : [];
  updateAgentSignals(agents);

  var healthAgents = [];
  var counts = {
    cruising: 0,
    working: 0,
    struggling: 0,
    stuck: 0,
  };

  for (var i = 0; i < agents.length; i++) {
    var health = buildAgentHealth(agents[i]);
    health.agent = agents[i];
    healthAgents.push(health);
    counts[health.level] += 1;
  }

  var aggregate = 'idle';
  if (counts.stuck > 0) {
    aggregate = 'stuck';
  } else if (counts.struggling > 0) {
    aggregate = 'struggling';
  } else if (counts.working > 0) {
    aggregate = 'working';
  } else if (counts.cruising > 0) {
    aggregate = 'cruising';
  }

  var summaryParts = [];
  if (counts.cruising > 0) summaryParts.push(countLabel(counts.cruising, 'cruising agent', 'cruising agents'));
  if (counts.working > 0) summaryParts.push(countLabel(counts.working, 'working agent', 'working agents'));
  if (counts.struggling > 0) summaryParts.push(countLabel(counts.struggling, 'struggling agent', 'struggling agents'));
  if (counts.stuck > 0) summaryParts.push(countLabel(counts.stuck, 'stuck agent', 'stuck agents'));

  return {
    aggregate: aggregate,
    tone: healthTone(aggregate === 'idle' ? 'working' : aggregate),
    counts: counts,
    agents: healthAgents,
    summary: summaryParts.join(' \u00b7 ') || 'No active health signals.',
  };
}

function findAgentHealth(healthSnapshot, agent) {
  if (!healthSnapshot || !Array.isArray(healthSnapshot.agents)) return null;
  var key = getAgentKey(agent);
  for (var i = 0; i < healthSnapshot.agents.length; i++) {
    if (healthSnapshot.agents[i].key === key) {
      return healthSnapshot.agents[i];
    }
  }
  return null;
}

function listAgentNames(agents) {
  var names = [];

  for (var i = 0; i < (agents || []).length; i++) {
    var agent = agents[i];
    if (!agent || agent.persona === 'steward') continue;
    var name = agent.displayName || agent.agentId || 'agent';
    if (names.indexOf(name) === -1) {
      names.push(name);
    }
  }

  return names;
}

function formatCompactList(items, limit) {
  var values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (values.length === 0) return '';

  var max = typeof limit === 'number' ? limit : 3;
  var shown = values.slice(0, max);
  var suffix = values.length > max ? ' +' + (values.length - max) : '';

  return shown.join(', ') + suffix;
}

function formatAttentionLabel(input) {
  if (input.urgentCount > 0) {
    return input.urgentCount === 1 ? '1 urgent' : input.urgentCount + ' urgent';
  }

  if (input.needsYouCount > 0) {
    return input.needsYouCount === 1 ? '1 needs you' : input.needsYouCount + ' need you';
  }

  if (input.activeCount > 0) {
    return input.activeCount === 1 ? '1 in flight' : input.activeCount + ' in flight';
  }

  return 'all clear';
}

function renderRailActionButton(label, attrs, quiet) {
  var html = '<button class="rail-action-btn' + (quiet ? ' rail-action-btn--quiet' : '') + '" type="button"';

  for (var key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    var value = attrs[key];
    if (value === null || value === undefined || value === '') continue;
    html += ' ' + key + '="' + escapeAttr(String(value)) + '"';
  }

  html += '>' + escapeHtml(label) + '</button>';
  return html;
}

function buildAttentionItems(liveSnapshot, queueSnapshot, healthSnapshot) {
  var items = [];
  var approvals = queueSnapshot && Array.isArray(queueSnapshot.approvals) ? queueSnapshot.approvals : [];
  var waitingOnHuman = queueSnapshot && Array.isArray(queueSnapshot.waitingOnHuman) ? queueSnapshot.waitingOnHuman : [];
  var incidents = queueSnapshot && Array.isArray(queueSnapshot.incidents) ? queueSnapshot.incidents : [];
  var agents = liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : [];
  var recentCompletions = liveSnapshot && Array.isArray(liveSnapshot.recentCompletions)
    ? liveSnapshot.recentCompletions
    : [];
  var latestActivity = liveSnapshot && Array.isArray(liveSnapshot.activity) && liveSnapshot.activity.length > 0
    ? liveSnapshot.activity[0]
    : null;

  for (var i = 0; i < incidents.length; i++) {
    var incident = incidents[i];
    items.push({
      id: incident.id || ('incident-' + i),
      kind: 'incident',
      tone: incident.severity === 'error' ? 'error' : 'warning',
      priority: incident.severity === 'error' ? 0 : 3,
      ts: incident.ts || '',
      title: incident.summary || incident.kind || 'Incident',
      summary: truncateText((incident.details || []).join(' \u00b7 ') || 'An external incident was raised for this project.', 180),
      meta: joinMeta([
        incident.source || '',
        incident.kind || '',
        formatMoment(incident.ts),
      ]),
      prompt:
        'I saw this incident: "' + (incident.summary || incident.kind || 'Incident') +
        '". Give me a crisp brief on what happened, the impact, and whether you need a decision from me.',
      openTab: 'queue',
      focusId: 'queue-incidents',
    });
  }

  for (var j = 0; j < approvals.length; j++) {
    var approval = approvals[j];
    items.push({
      id: approval.id || ('approval-' + j),
      kind: 'approval',
      tone: 'warning',
      priority: 1,
      ts: approval.created || '',
      title: approval.summary || approval.kind || 'Approval requested',
      summary: truncateText(approval.note || 'A yes/no call is waiting before work can continue.', 180),
      meta: joinMeta([
        approval.kind || '',
        approval.requestedBy ? 'requested by ' + approval.requestedBy : '',
        formatMoment(approval.created),
      ]),
      prompt:
        'We have a pending approval: "' + (approval.summary || approval.kind || 'Approval requested') +
        '". Give me the context, your recommendation, and the tradeoffs in 3 bullets.',
      openTab: 'queue',
      focusId: 'queue-approvals',
    });
  }

  for (var k = 0; k < waitingOnHuman.length; k++) {
    var waiting = waitingOnHuman[k];
    items.push({
      id: waiting.id || ('waiting-' + k),
      kind: 'waiting',
      tone: 'info',
      priority: 2,
      ts: waiting.ts || '',
      title: waiting.summary || waiting.type || 'Human input needed',
      summary: 'The hive is paused until you answer this thread.',
      meta: joinMeta([
        waiting.type || 'message',
        waiting.from ? 'from ' + waiting.from : '',
        formatMoment(waiting.ts),
      ]),
      prompt:
        'We are waiting on a human reply for "' + (waiting.summary || waiting.type || 'this thread') +
        '". Draft the reply you recommend and tell me what happens next if I send it.',
      openTab: 'queue',
      focusId: 'queue-waiting-human',
    });
  }

  var healthIssues = healthSnapshot && Array.isArray(healthSnapshot.agents)
    ? healthSnapshot.agents.filter(function (item) {
      return item.level === 'stuck' || item.level === 'struggling';
    })
    : [];
  for (var h = 0; h < healthIssues.length; h++) {
    var issue = healthIssues[h];
    var issueAgent = issue.agent || null;
    var issueName = issueAgent ? (issueAgent.displayName || issueAgent.agentId || 'agent') : 'agent';
    var issuePriority = issue.level === 'stuck' ? 0 : 3;
    items.push({
      id: 'health-' + issue.key,
      kind: 'health',
      tone: issue.level === 'stuck' ? 'error' : 'warning',
      priority: issuePriority,
      ts: issueAgent ? issueAgent.started : '',
      title: issue.level === 'stuck'
        ? issueName + ' looks stuck.'
        : issueName + ' is starting to struggle.',
      summary: issue.summary,
      meta: joinMeta([
        issue.label,
        issue.staleLabel,
        issue.ageLabel,
      ]),
      prompt:
        'Take a look at ' + issueName +
        '. Give me a short health brief: what it is doing, why it looks ' + issue.label +
        ', and whether you want me to intervene.',
      openTab: 'live',
      focusId: 'live-agents',
    });
  }

  if (agents.length > 0) {
    var agentNames = listAgentNames(agents);
    items.push({
      id: 'active-work',
      kind: 'active',
      tone: approvals.length > 0 || waitingOnHuman.length > 0 || incidents.length > 0 ? 'info' : 'success',
      priority: 4,
      ts: latestActivity ? latestActivity.ts : (agents[0].started || ''),
      title: agents.length === 1 ? 'One thread is actively moving.' : countLabel(agents.length, 'live thread') + ' are moving.',
      summary:
        agentNames.length > 0
          ? 'Running now: ' + formatCompactList(agentNames, 4) + '.'
          : 'The steward is actively working the current conversation.',
      meta: joinMeta([
        latestActivity ? 'latest ' + formatMoment(latestActivity.ts) : '',
        agents.length > 0 ? countLabel(agents.length, 'active run') : '',
      ]),
      openTab: 'live',
      focusId: 'live-agents',
    });
  } else if (recentCompletions.length > 0) {
    var completion = recentCompletions[0];
    items.push({
      id: 'recent-completion-' + (completion.runId || 'latest'),
      kind: 'recent',
      tone: 'success',
      priority: 5,
      ts: completion.ended || '',
      title: (completion.displayName || completion.agentId || 'worker') + ' just wrapped a pass.',
      summary: truncateText(completion.summary || 'Recent work completed cleanly.', 180),
      meta: joinMeta([
        completion.runtime || '',
        completion.model || '',
        formatMoment(completion.ended),
      ]),
      openTab: 'timeline',
      focusId: 'timeline-list',
    });
  }

  items.sort(function (left, right) {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return String(right.ts || '').localeCompare(String(left.ts || ''));
  });

  return items.slice(0, 6);
}

function buildLeadershipSnapshot() {
  var liveSnapshot = state.liveSnapshot;
  var healthSnapshot = state.healthSnapshot;
  var queueSnapshot = state.queueSnapshot;
  var project =
    getProjectFocus() ||
    (liveSnapshot && liveSnapshot.project) ||
    (queueSnapshot && queueSnapshot.project) ||
    null;
  var activeAgents = liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : [];
  var attentionItems = buildAttentionItems(liveSnapshot, queueSnapshot, healthSnapshot);
  var urgentCount = 0;
  var needsYouCount = 0;

  for (var i = 0; i < attentionItems.length; i++) {
    if (attentionItems[i].tone === 'error') {
      urgentCount += 1;
    }
    if (
      attentionItems[i].kind === 'approval' ||
      attentionItems[i].kind === 'waiting' ||
      attentionItems[i].kind === 'incident' ||
      (attentionItems[i].kind === 'health' && attentionItems[i].tone === 'error')
    ) {
      needsYouCount += 1;
    }
  }

  var badgeTone = 'clear';
  if (urgentCount > 0) {
    badgeTone = 'error';
  } else if (needsYouCount > 0) {
    badgeTone = 'warning';
  } else if (activeAgents.length > 0) {
    badgeTone = 'info';
  }

  return {
    project: project,
    attentionItems: attentionItems,
    health: healthSnapshot,
    badgeTone: badgeTone,
    badgeLabel: formatAttentionLabel({
      urgentCount: urgentCount,
      needsYouCount: needsYouCount,
      activeCount: activeAgents.length,
    }),
    badgeCount: urgentCount || needsYouCount || activeAgents.length || 0,
  };
}

function renderAttentionBadge(leadership) {
  var button = document.getElementById('attention-badge');
  if (!button) return;

  var icon = button.querySelector('.topbar-attention-icon');
  var label = button.querySelector('.topbar-attention-label');
  var tone = leadership ? leadership.badgeTone : 'clear';
  var text = leadership ? leadership.badgeLabel : 'all clear';
  var count = leadership ? leadership.badgeCount : 0;

  button.className = 'topbar-attention topbar-attention--' + tone;
  button.setAttribute('title', tone === 'clear'
    ? 'Open attention queue'
    : 'Open attention queue (' + text + ')');

  if (label) {
    label.textContent = text;
  }
  if (icon) {
    icon.textContent = count > 0 ? String(Math.min(count, 9)) : '!';
  }
}

function renderHealthIndicator(healthSnapshot) {
  var button = document.getElementById('health-indicator');
  if (!button) return;

  var icon = button.querySelector('.topbar-health-icon');
  var label = button.querySelector('.topbar-health-label');
  var aggregate = healthSnapshot ? healthSnapshot.aggregate : 'idle';
  var summary = healthSnapshot ? healthSnapshot.summary : 'No active health signals.';

  button.className = 'topbar-health topbar-health--' + aggregate;
  button.setAttribute('title', summary);

  if (icon) {
    icon.textContent = healthIcon(aggregate);
  }
  if (label) {
    label.textContent = aggregate;
  }
}

function renderHealthPill(health) {
  if (!health) return '';

  return '<div class="health-pill health-pill--' + escapeAttr(health.label) + '">' +
    '<span class="health-pill-icon">' + escapeHtml(health.icon) + '</span>' +
    '<span>' + escapeHtml(health.label) + '</span>' +
    '</div>';
}

function renderAttentionQueue(leadership) {
  if (!leadership || !leadership.project || !leadership.attentionItems || leadership.attentionItems.length === 0) {
    renderQueueCards('queue-attention', '', 'Nothing needs you right now.');
    return;
  }

  var html = '';
  for (var i = 0; i < leadership.attentionItems.length; i++) {
    var item = leadership.attentionItems[i];
    html += '<div class="' + toneClass('queue-card', item.tone) + '">';
    html += '<div class="queue-card-header"><div class="queue-card-title">' + escapeHtml(item.title) + '</div>';
    html += '<div class="queue-card-time">' + escapeHtml(formatMoment(item.ts)) + '</div></div>';
    html += '<div class="queue-card-meta">' + escapeHtml(item.meta || '') + '</div>';
    html += '<div class="queue-card-body">' + escapeHtml(item.summary || '') + '</div>';
    html += '<div class="queue-card-actions">';
    if (item.prompt) {
      html += renderRailActionButton('Ask Hive', {
        'data-rail-action': 'send-prompt',
        'data-rail-prompt': item.prompt,
      });
    }
    if (item.openTab) {
      html += renderRailActionButton(
        item.openTab === 'live' ? 'Open Live' : (item.openTab === 'timeline' ? 'Open Timeline' : 'Open Queue'),
        {
          'data-rail-action': 'focus-tab',
          'data-rail-tab-target': item.openTab,
          'data-rail-focus-id': item.focusId || '',
        },
        true
      );
    }
    html += '</div>';
    html += '</div>';
  }

  renderQueueCards('queue-attention', html, 'Nothing needs you right now.');
}

function humanizeActivityTitle(activity) {
  if (!activity) return 'The hive made a move.';

  var actor = activity.actor || 'The hive';
  var kind = String(activity.kind || '').toLowerCase();

  if (kind === 'worker-result') {
    return actor + ' turned in a result.';
  }
  if (kind === 'steward-result') {
    return 'The steward closed a coordination pass.';
  }
  if (kind === 'human-message') {
    return 'A direction just landed.';
  }
  if (kind === 'message-cleared') {
    return actor + ' cleared a thread.';
  }
  if (kind === 'run-finished') {
    return actor + ' wrapped a run.';
  }

  if (activity.title) {
    return activity.title.charAt(0).toUpperCase() + activity.title.slice(1) + '.';
  }

  return actor + ' made a move.';
}

function buildPulseItems(leadership, liveSnapshot) {
  var items = [];
  var seen = {};
  var attentionItems = leadership && Array.isArray(leadership.attentionItems) ? leadership.attentionItems : [];
  var recentCompletions = liveSnapshot && Array.isArray(liveSnapshot.recentCompletions)
    ? liveSnapshot.recentCompletions
    : [];
  var activity = liveSnapshot && Array.isArray(liveSnapshot.activity) ? liveSnapshot.activity : [];
  var agents = liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : [];

  function pushPulse(item) {
    if (!item || !item.id || seen[item.id]) return;
    seen[item.id] = true;
    items.push(item);
  }

  for (var i = 0; i < attentionItems.length && i < 2; i++) {
    var attention = attentionItems[i];
    if (
      attention.kind !== 'incident' &&
      attention.kind !== 'approval' &&
      attention.kind !== 'waiting' &&
      attention.kind !== 'health'
    ) {
      continue;
    }

    pushPulse({
      id: 'pulse-attention-' + attention.id,
      tone: attention.tone,
      tag: attention.kind === 'incident'
        ? 'Needs you now'
        : (attention.kind === 'approval'
          ? 'Decision waiting'
          : (attention.kind === 'waiting' ? 'Reply waiting' : 'Health watch')),
      title: attention.title,
      summary: attention.summary,
      meta: attention.meta,
      ts: attention.ts,
      actionLabel: attention.kind === 'waiting' ? 'Draft Reply' : 'Ask Hive',
      actionPrompt: attention.prompt,
      secondaryLabel: 'Open Queue',
      secondaryTab: 'queue',
      secondaryFocusId: attention.focusId || 'queue-attention',
    });
  }

  for (var j = 0; j < recentCompletions.length && items.length < 4; j++) {
    var completion = recentCompletions[j];
    var changedFiles = Array.isArray(completion.changedFiles) ? completion.changedFiles.length : 0;
    pushPulse({
      id: 'pulse-completion-' + (completion.runId || j),
      tone: 'success',
      tag: 'Just finished',
      title: (completion.displayName || completion.agentId || 'worker') + ' wrapped a pass.',
      summary: truncateText(
        (completion.summary || 'Work completed cleanly.') +
        (changedFiles > 0 ? ' ' + countLabel(changedFiles, 'file') + ' changed.' : ''),
        170
      ),
      meta: joinMeta([
        completion.runtime || '',
        completion.model || '',
        formatMoment(completion.ended),
      ]),
      ts: completion.ended,
      secondaryLabel: 'Open Timeline',
      secondaryTab: 'timeline',
      secondaryFocusId: 'timeline-list',
    });
  }

  for (var k = 0; k < activity.length && items.length < 4; k++) {
    var activityItem = activity[k];
    pushPulse({
      id: 'pulse-activity-' + (activityItem.id || k),
      tone: activityItem.tone || 'info',
      tag: activityItem.actor ? activityItem.actor : 'Live signal',
      title: humanizeActivityTitle(activityItem),
      summary: truncateText(activityItem.detail || 'Fresh movement just hit the board.', 170),
      meta: joinMeta([
        activityItem.kind || '',
        formatMoment(activityItem.ts),
      ]),
      ts: activityItem.ts,
      actionLabel: 'Ask Context',
      actionPrompt:
        'Give me the context behind this update: "' + (activityItem.detail || activityItem.title || 'live signal') +
        '". Tell me what changed, why it matters, and whether you need anything from me.',
      secondaryLabel: 'Open Live',
      secondaryTab: 'live',
      secondaryFocusId: 'live-agents',
    });
  }

  if (items.length === 0 && agents.length > 0) {
    var activeAgent = agents[0];
    pushPulse({
      id: 'pulse-active-' + (activeAgent.runId || 'steward'),
      tone: 'info',
      tag: 'Still moving',
      title: (activeAgent.displayName || activeAgent.agentId || 'The steward') + ' is still working.',
      summary: truncateText(activeAgent.latestOutput || 'There is active work in flight right now.', 170),
      meta: joinMeta([
        activeAgent.runtime || '',
        activeAgent.model || '',
        formatMoment(activeAgent.started),
      ]),
      ts: activeAgent.started,
      secondaryLabel: 'Logs',
      secondaryRunId: activeAgent.runId || '',
    });
  }

  return items.slice(0, 4);
}

function renderPulsePanel(leadership) {
  var panel = document.getElementById('pulse-panel');
  var list = document.getElementById('pulse-panel-list');
  var toggle = document.getElementById('pulse-panel-toggle');

  if (!panel || !list || !toggle) return;

  var pulseItems = buildPulseItems(leadership, state.liveSnapshot);
  if (!leadership || !leadership.project || pulseItems.length === 0) {
    panel.hidden = true;
    panel.classList.remove('pulse-panel--collapsed');
    list.innerHTML = '';
    toggle.textContent = 'Collapse';
    return;
  }

  panel.hidden = false;
  panel.classList.toggle('pulse-panel--collapsed', state.pulsesCollapsed);
  toggle.textContent = state.pulsesCollapsed ? 'Expand' : 'Collapse';

  if (state.pulsesCollapsed) {
    list.innerHTML = '';
    return;
  }

  var html = '';
  for (var i = 0; i < pulseItems.length; i++) {
    var item = pulseItems[i];
    html += '<div class="' + toneClass('pulse-card', item.tone) + '">';
    html += '<div class="pulse-card-header">';
    html += '<div class="pulse-card-tag">' + escapeHtml(item.tag || 'Live pulse') + '</div>';
    html += '<div class="pulse-card-time">' + escapeHtml(formatMoment(item.ts)) + '</div>';
    html += '</div>';
    html += '<div class="pulse-card-title">' + escapeHtml(item.title) + '</div>';
    html += '<div class="pulse-card-summary">' + escapeHtml(item.summary || '') + '</div>';
    if (item.meta) {
      html += '<div class="pulse-card-meta">' + escapeHtml(item.meta) + '</div>';
    }
    html += '<div class="pulse-card-actions">';
    if (item.actionPrompt) {
      html += renderRailActionButton(item.actionLabel || 'Ask Hive', {
        'data-rail-action': 'send-prompt',
        'data-rail-prompt': item.actionPrompt,
      });
    }
    if (item.secondaryRunId) {
      html += renderRailActionButton(item.secondaryLabel || 'Logs', {
        'data-rail-action': 'log',
        'data-rail-run-id': item.secondaryRunId,
      }, true);
    } else if (item.secondaryTab) {
      html += renderRailActionButton(item.secondaryLabel || 'Open', {
        'data-rail-action': 'focus-tab',
        'data-rail-tab-target': item.secondaryTab,
        'data-rail-focus-id': item.secondaryFocusId || '',
      }, true);
    }
    html += '</div>';
    html += '</div>';
  }

  list.innerHTML = html;
}

function dismissToast(key) {
  if (!key) return;
  state.toasts = state.toasts.filter(function (item) {
    return item.key !== key;
  });
  renderToastStack();
}

function renderToastStack() {
  var container = document.getElementById('toast-stack');
  if (!container) return;

  if (!state.toasts || state.toasts.length === 0) {
    container.innerHTML = '';
    return;
  }

  var html = '';
  for (var i = 0; i < state.toasts.length; i++) {
    var toast = state.toasts[i];
    html += '<div class="' + toneClass('toast-card', toast.tone) + '">';
    html += '<div class="toast-card-header">';
    html += '<div class="toast-card-kicker">' + escapeHtml(toast.kicker || 'HIVE') + '</div>';
    html += '<div class="toast-card-time">' + escapeHtml(formatMoment(toast.ts)) + '</div>';
    html += '</div>';
    html += '<div class="toast-card-title">' + escapeHtml(toast.title) + '</div>';
    html += '<div class="toast-card-summary">' + escapeHtml(toast.summary || '') + '</div>';
    html += '<div class="toast-card-actions">';
    if (toast.actionPrompt) {
      html += renderRailActionButton(toast.actionLabel || 'Ask Hive', {
        'data-rail-action': 'send-prompt',
        'data-rail-prompt': toast.actionPrompt,
      });
    }
    if (toast.secondaryRunId) {
      html += renderRailActionButton(toast.secondaryLabel || 'Logs', {
        'data-rail-action': 'log',
        'data-rail-run-id': toast.secondaryRunId,
      }, true);
    } else if (toast.secondaryTab) {
      html += renderRailActionButton(toast.secondaryLabel || 'Open', {
        'data-rail-action': 'focus-tab',
        'data-rail-tab-target': toast.secondaryTab,
        'data-rail-focus-id': toast.secondaryFocusId || '',
      }, true);
    }
    html += '<button class="toast-dismiss" type="button" data-toast-dismiss="' + escapeAttr(toast.key) + '">Dismiss</button>';
    html += '</div>';
    html += '</div>';
  }

  container.innerHTML = html;
}

function addToast(toast) {
  if (!toast || !toast.key || state.toastSeenKeys[toast.key]) return;

  state.toastSeenKeys[toast.key] = true;
  state.toasts = [toast].concat(state.toasts || []).slice(0, 4);
  renderToastStack();

  var ttl = toast.tone === 'error' ? 18000 : (toast.tone === 'warning' ? 14000 : 9000);
  setTimeout(function () {
    dismissToast(toast.key);
  }, ttl);
}

function maybeEmitLeadershipToasts(leadership) {
  if (!leadership || !leadership.project) return;

  var candidates = [];
  var attentionItems = leadership.attentionItems || [];
  var recentCompletions = state.liveSnapshot && Array.isArray(state.liveSnapshot.recentCompletions)
    ? state.liveSnapshot.recentCompletions
    : [];

  for (var i = 0; i < attentionItems.length; i++) {
    var item = attentionItems[i];
    if (item.tone !== 'error' && item.kind !== 'approval' && item.kind !== 'health') {
      continue;
    }

    candidates.push({
      key: 'toast-attention-' + item.id,
      tone: item.tone,
      kicker: item.tone === 'error' ? 'Needs you now' : 'Leadership heads-up',
      title: item.title,
      summary: item.summary,
      ts: item.ts,
      actionLabel: item.kind === 'waiting' ? 'Draft Reply' : 'Ask Hive',
      actionPrompt: item.prompt,
      secondaryLabel: item.openTab === 'queue' ? 'Open Queue' : 'Open Live',
      secondaryTab: item.openTab || 'queue',
      secondaryFocusId: item.focusId || '',
    });
  }

  if (recentCompletions.length > 0) {
    var completion = recentCompletions[0];
    candidates.push({
      key: 'toast-completion-' + (completion.runId || 'latest'),
      tone: 'success',
      kicker: 'Completed',
      title: (completion.displayName || completion.agentId || 'worker') + ' wrapped a pass.',
      summary: truncateText(completion.summary || 'Recent work completed cleanly.', 150),
      ts: completion.ended,
      secondaryLabel: 'Open Timeline',
      secondaryTab: 'timeline',
      secondaryFocusId: 'timeline-list',
    });
  }

  if (!state.notificationsPrimed) {
    for (var p = 0; p < candidates.length; p++) {
      if (candidates[p].tone !== 'error') {
        state.toastSeenKeys[candidates[p].key] = true;
      }
    }
    state.notificationsPrimed = true;
    candidates = candidates.filter(function (item) {
      return item.tone === 'error';
    });
  }

  for (var j = 0; j < candidates.length && j < 2; j++) {
    addToast(candidates[j]);
  }
}

function renderLeadershipSurface() {
  var leadership = buildLeadershipSnapshot();
  renderHealthIndicator(leadership.health);
  renderAttentionBadge(leadership);
  renderAttentionQueue(leadership);
  renderPulsePanel(leadership);
  maybeEmitLeadershipToasts(leadership);
  renderToastStack();
}

function focusRailSection(tab, focusId) {
  if (tab === 'live' && focusId && focusId !== 'process-logs-section' && state.processLogsFocus) {
    clearProcessLogFocus();
  }

  setRailTab(tab || 'live');

  window.requestAnimationFrame(function () {
    var target = focusId ? document.getElementById(focusId) : null;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function focusProcessLog(runId) {
  if (!runId) return;

  state.processLogsFocus = runId;
  state.processLogsStickToBottom = true;
  setRailTab('live');
  renderProcessLogs(state.processLogsSnapshot);
  scheduleProcessLogsRefresh(0);

  window.requestAnimationFrame(function () {
    var section = document.getElementById('process-logs-section');
    var container = document.getElementById('process-logs-content');
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });
}

function clearProcessLogFocus() {
  if (!state.processLogsFocus) return;
  resetProcessLogFocus(false);
  renderProcessLogs(state.processLogsSnapshot);
}

function renderConsoleActivity(snapshot) {
  var container = document.getElementById('console-activity');
  if (!container) return;

  if (!snapshot || !snapshot.project) {
    container.innerHTML = '<div class="console-activity-empty">No live hive activity yet.</div>';
    return;
  }

  var summary = truncateText(snapshot.summary || 'No active work is in motion right now.', 220);
  var latest = snapshot.activity && snapshot.activity[0] ? snapshot.activity[0] : null;
  var meta = [
    'project ' + snapshot.project,
    snapshot.supervisor ? 'supervisor ' + (snapshot.supervisor.status || 'unknown') : 'supervisor offline',
    snapshot.agents && snapshot.agents.length > 0
      ? countLabel(snapshot.agents.length, 'live agent')
      : 'no live agents',
    latest ? 'latest ' + formatMoment(latest.ts) : '',
  ];

  var html = '<div class="console-activity-summary">';
  html += '<div class="console-activity-summary-line">' + escapeHtml(summary) + '</div>';
  html += '<div class="console-activity-summary-meta">' + escapeHtml(joinMeta(meta)) + '</div>';
  html += '</div>';

  container.innerHTML = html;
}

function renderLiveSummary(snapshot) {
  var container = document.getElementById('live-summary');
  if (!container) return;

  if (!snapshot || !snapshot.project) {
    container.innerHTML = '<div class="rail-empty">No project in focus yet.</div>';
    return;
  }

  var supervisorStatus = snapshot.supervisor ? (snapshot.supervisor.status || 'unknown') : 'offline';
  var healthSnapshot = state.healthSnapshot;
  var html = '<div class="live-summary-block">';
  html += '<div class="live-summary-label">Working Now</div>';
  html += '<div class="live-summary-value">' + escapeHtml(snapshot.summary || 'No active work is in motion right now.') + '</div>';
  html += '</div>';
  html += '<div class="live-summary-grid">';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Project</div><div class="live-summary-stat-value">' + escapeHtml(snapshot.project) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Session</div><div class="live-summary-stat-value">' + escapeHtml(snapshot.sessionId || 'none') + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Supervisor</div><div class="live-summary-stat-value">' + escapeHtml(supervisorStatus) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Live Agents</div><div class="live-summary-stat-value">' + escapeHtml(String((snapshot.agents || []).length)) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Team Health</div><div class="live-summary-stat-value">' +
    escapeHtml(healthSnapshot ? healthSnapshot.aggregate : 'idle') +
    '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Health Mix</div><div class="live-summary-stat-value">' +
    escapeHtml(healthSnapshot ? healthSnapshot.summary : 'No active health signals.') +
    '</div></div>';
  html += '</div>';

  container.innerHTML = html;
}

function renderLiveAgents(agents) {
  var container = document.getElementById('live-agents');
  if (!container) return;

  if (!Array.isArray(agents) || agents.length === 0) {
    container.innerHTML = '<div class="rail-empty">No active agents.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < agents.length; i++) {
    var agent = agents[i];
    var health = findAgentHealth(state.healthSnapshot, agent);
    var outputPreview = '';
    var descriptor = agent.descriptor || '';
    if (descriptor && agent.persona && descriptor.toLowerCase() === String(agent.persona).toLowerCase()) {
      descriptor = '';
    }
    if (Array.isArray(agent.tail) && agent.tail.length > 0) {
      outputPreview = truncateMultilineText(agent.tail.slice(-4).join('\n'), 420);
    } else if (agent.latestOutput) {
      outputPreview = truncateMultilineText(agent.latestOutput, 320);
    }
    var meta = [
      agent.runtime || '',
      agent.model || '',
      formatMoment(agent.started),
      agent.pid ? 'pid ' + agent.pid : '',
      agent.taskId ? 'task ' + agent.taskId : '',
    ];
    html += '<div class="agent-card">';
    html += '<div class="agent-card-header">';
    html += '<div class="agent-card-header-copy">';
    html += '<div class="agent-card-name">' + escapeHtml(agent.displayName || agent.agentId || 'agent') + '</div>';
    html += '<div class="agent-card-descriptor">' + escapeHtml(joinMeta([agent.persona, descriptor])) + '</div>';
    html += '</div>';
    html += '<div class="agent-card-statuses">';
    html += renderHealthPill(health);
    html += '<div class="' + toneClass('status-pill', toneFromStatus(agent.status)) + '">' + escapeHtml(agent.status || 'active') + '</div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="agent-card-meta">' + escapeHtml(joinMeta(meta)) + '</div>';
    if (health) {
      html += '<div class="agent-card-health-note">' + escapeHtml(health.summary) + '</div>';
    }
    if (outputPreview) {
      html += '<div class="agent-card-output">' + escapeHtml(outputPreview) + '</div>';
    } else {
      var emptyOutput = agent.persona === 'steward'
        ? 'Waiting for the first streamed update from the steward.'
        : 'Waiting for the first visible update from this agent.';
      html += '<div class="agent-card-output agent-card-output--empty">' + escapeHtml(emptyOutput) + '</div>';
    }
    html += '<div class="agent-card-actions">';
    html += renderRailActionButton(state.processLogsFocus === (agent.runId || '') ? 'Watching' : 'Logs', {
      'data-rail-action': 'log',
      'data-rail-run-id': agent.runId || '',
    }, state.processLogsFocus === (agent.runId || ''));
    html += '</div>';
    html += '</div>';
  }

  container.innerHTML = html;
}

function getLiveAgentForRun(runId) {
  var agents = state.liveSnapshot && Array.isArray(state.liveSnapshot.agents) ? state.liveSnapshot.agents : [];
  for (var i = 0; i < agents.length; i++) {
    if (agents[i].runId === runId) {
      return agents[i];
    }
  }
  return null;
}

function buildProcessLogSelection(snapshot) {
  var focus = state.processLogsFocus;
  if (!focus) return null;
  if (!snapshot || !snapshot.project) return null;

  if (focus === 'supervisor') {
    if (snapshot && snapshot.supervisor) {
      return {
        kind: 'supervisor',
        title: 'Supervisor live output',
        subtitle: joinMeta([
          snapshot.project || '',
          'status ' + (snapshot.supervisor.status || 'unknown'),
          snapshot.supervisor.pid ? 'pid ' + snapshot.supervisor.pid : '',
        ]),
        note: 'Watching the detached supervisor log for fresh coordination output.',
        tail: snapshot.supervisor.tail || [],
      };
    }

    return {
      kind: 'missing',
      title: 'Supervisor live output',
      subtitle: 'No active supervisor log found for this project.',
      note: 'The detached supervisor may have stopped or rotated out since you opened the inspector.',
      tail: [],
    };
  }

  var runs = snapshot && Array.isArray(snapshot.runs) ? snapshot.runs : [];
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    if (run.runId !== focus) continue;

    var liveAgent = getLiveAgentForRun(run.runId);
    var displayName = liveAgent
      ? (liveAgent.displayName || liveAgent.agentId || run.agentId || 'agent')
      : (run.agentId || 'agent');

    return {
      kind: 'run',
      title: displayName + ' live output',
      subtitle: joinMeta([
        liveAgent ? liveAgent.persona || '' : '',
        run.status || 'active',
        run.runtime || '',
        run.model || '',
        formatMoment(run.started),
        run.pid ? 'pid ' + run.pid : '',
      ]),
      note: 'Watching the latest visible agent output as it streams in.',
      tail: run.tail || [],
    };
  }

  return {
    kind: 'missing',
    title: 'Live output unavailable',
    subtitle: 'Run ' + focus + ' is no longer active.',
    note: 'This agent may have finished or been replaced since you opened the inspector.',
    tail: [],
  };
}

function renderProcessLogsChrome(selection) {
  var livePanel = document.getElementById('rail-panel-live');
  var title = document.getElementById('process-logs-title');
  var subtitle = document.getElementById('process-logs-subtitle');
  var backBtn = document.getElementById('process-logs-back');
  var inspecting = Boolean(selection);

  if (livePanel) {
    livePanel.classList.toggle('rail-panel--log-focus', inspecting);
  }
  if (title) {
    title.textContent = inspecting ? 'Live Output' : 'Raw Logs';
  }
  if (subtitle) {
    subtitle.hidden = !inspecting;
    subtitle.textContent = inspecting ? (selection.subtitle || '') : '';
  }
  if (backBtn) {
    backBtn.hidden = !inspecting;
  }
}

function renderProcessLogBlock(title, meta, tailLines, runId) {
  var tail = tailLines && tailLines.length > 0
    ? escapeHtml(tailLines.join('\n'))
    : '<span class="process-log-empty-line">(no output yet)</span>';
  var actions = runId
    ? '<div class="process-log-block-actions">' + renderRailActionButton(
      state.processLogsFocus === runId ? 'Watching' : 'Inspect',
      {
        'data-rail-action': 'log',
        'data-rail-run-id': runId,
      },
      state.processLogsFocus === runId
    ) + '</div>'
    : '';

  return '<div class="process-log-block" data-process-log-run-id="' + escapeAttr(runId || '') + '">' +
    '<div class="process-log-block-header">' +
    '<div class="process-log-block-copy">' +
    '<div class="process-log-title">' + escapeHtml(title) + '</div>' +
    '<div class="process-log-meta">' + escapeHtml(meta) + '</div>' +
    '</div>' +
    actions +
    '</div>' +
    '<pre class="process-log-tail">' + tail + '</pre>' +
    '</div>';
}

function renderProcessLogInspector(selection) {
  var tail = selection.tail && selection.tail.length > 0
    ? escapeHtml(selection.tail.join('\n'))
    : '<span class="process-log-empty-line">(waiting for visible output)</span>';

  return '<div class="process-log-inspector">' +
    '<div class="process-log-inspector-header">' +
    '<div class="process-log-inspector-title">' + escapeHtml(selection.title) + '</div>' +
    '<div class="process-log-inspector-meta">' + escapeHtml(selection.subtitle || '') + '</div>' +
    '<div class="process-log-inspector-note">' + escapeHtml(selection.note || '') + '</div>' +
    '</div>' +
    '<pre class="process-log-inspector-tail">' + tail + '</pre>' +
    '</div>';
}

function renderProcessLogs(snapshot) {
  var container = document.getElementById('process-logs-content');
  if (!container) return;

  var selection = buildProcessLogSelection(snapshot);
  renderProcessLogsChrome(selection);

  if (!snapshot || !snapshot.project) {
    container.innerHTML = '<div class="process-logs-empty">No project in focus yet. Start a session or switch project focus.</div>';
    return;
  }

  if (selection) {
    container.innerHTML = renderProcessLogInspector(selection);
    if (state.processLogsStickToBottom) {
      container.scrollTop = container.scrollHeight;
    }
    return;
  }

  var html = '';

  if (snapshot.supervisor) {
    html += renderProcessLogBlock(
      'Supervisor \u00b7 ' + snapshot.project,
      joinMeta([
        'status ' + (snapshot.supervisor.status || 'unknown'),
        snapshot.supervisor.pid ? 'pid ' + snapshot.supervisor.pid : '',
      ]),
      snapshot.supervisor.tail || [],
      'supervisor'
    );
  }

  var runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    var liveAgent = getLiveAgentForRun(run.runId || '');
    var runName = liveAgent
      ? (liveAgent.displayName || liveAgent.agentId || run.agentId || 'agent')
      : (run.agentId || 'agent');
    html += renderProcessLogBlock(
      runName + ' \u00b7 ' + snapshot.project,
      joinMeta([
        liveAgent ? liveAgent.persona || '' : '',
        run.status || 'active',
        run.runtime || '',
        run.model || '',
        formatMoment(run.started),
        run.pid ? 'pid ' + run.pid : '',
      ]),
      run.tail || [],
      run.runId || ''
    );
  }

  if (!html) {
    container.innerHTML = '<div class="process-logs-empty">No active supervisor or agent logs for ' + escapeHtml(snapshot.project) + '.</div>';
    return;
  }

  container.innerHTML = html;
}

function renderQueueCards(containerId, itemsHtml, emptyText) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = itemsHtml || '<div class="rail-empty">' + escapeHtml(emptyText) + '</div>';
}

function renderQueueSnapshot(snapshot) {
  if (!snapshot || !snapshot.project) {
    renderQueueCards('queue-attention', '', 'Nothing needs you right now.');
    renderQueueCards('queue-approvals', '', 'No pending approvals.');
    renderQueueCards('queue-waiting-human', '', 'Nothing is waiting on a human reply.');
    renderQueueCards('queue-incidents', '', 'No active incidents.');
    return;
  }

  var approvalsHtml = '';
  var approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  for (var i = 0; i < approvals.length; i++) {
    var approval = approvals[i];
    approvalsHtml += '<div class="queue-card queue-card--warning">';
    approvalsHtml += '<div class="queue-card-header"><div class="queue-card-title">' + escapeHtml(approval.summary || approval.kind || 'Approval requested') + '</div>';
    approvalsHtml += '<div class="queue-card-time">' + escapeHtml(formatMoment(approval.created)) + '</div></div>';
    approvalsHtml += '<div class="queue-card-meta">' + escapeHtml(joinMeta([
      approval.kind || '',
      approval.requestedBy ? 'requested by ' + approval.requestedBy : '',
      approval.project || 'global',
    ])) + '</div>';
    if (approval.note) {
      approvalsHtml += '<div class="queue-card-body">' + escapeHtml(truncateText(approval.note, 180)) + '</div>';
    }
    approvalsHtml += '<div class="queue-card-actions">';
    approvalsHtml += renderRailActionButton('Ask Hive', {
      'data-rail-action': 'send-prompt',
      'data-rail-prompt':
        'We have a pending approval: "' + (approval.summary || approval.kind || 'Approval requested') +
        '". Give me the context, your recommendation, and the tradeoffs in 3 bullets.',
    });
    approvalsHtml += '</div>';
    approvalsHtml += '</div>';
  }
  renderQueueCards('queue-approvals', approvalsHtml, 'No pending approvals.');

  var waitingHtml = '';
  var waiting = Array.isArray(snapshot.waitingOnHuman) ? snapshot.waitingOnHuman : [];
  for (var j = 0; j < waiting.length; j++) {
    var item = waiting[j];
    waitingHtml += '<div class="queue-card queue-card--info">';
    waitingHtml += '<div class="queue-card-header"><div class="queue-card-title">' + escapeHtml(item.summary || item.type || 'Human input needed') + '</div>';
    waitingHtml += '<div class="queue-card-time">' + escapeHtml(formatMoment(item.ts)) + '</div></div>';
    waitingHtml += '<div class="queue-card-meta">' + escapeHtml(joinMeta([
      item.type || 'message',
      item.from ? 'from ' + item.from : '',
      item.to ? 'to ' + item.to : '',
    ])) + '</div>';
    waitingHtml += '<div class="queue-card-actions">';
    waitingHtml += renderRailActionButton('Draft Reply', {
      'data-rail-action': 'send-prompt',
      'data-rail-prompt':
        'We are waiting on a human reply for "' + (item.summary || item.type || 'this thread') +
        '". Draft the reply you recommend and tell me what happens next if I send it.',
    });
    waitingHtml += '</div>';
    waitingHtml += '</div>';
  }
  renderQueueCards('queue-waiting-human', waitingHtml, 'Nothing is waiting on a human reply.');

  var incidentsHtml = '';
  var incidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];
  for (var k = 0; k < incidents.length; k++) {
    var incident = incidents[k];
    incidentsHtml += '<div class="' + toneClass('queue-card', incident.severity === 'error' ? 'error' : 'warning') + '">';
    incidentsHtml += '<div class="queue-card-header"><div class="queue-card-title">' + escapeHtml(incident.summary || incident.kind || 'Incident') + '</div>';
    incidentsHtml += '<div class="queue-card-time">' + escapeHtml(formatMoment(incident.ts)) + '</div></div>';
    incidentsHtml += '<div class="queue-card-meta">' + escapeHtml(joinMeta([
      incident.source || '',
      incident.kind || '',
      incident.routed ? 'routed' : 'unrouted',
    ])) + '</div>';
    if (incident.details && incident.details.length > 0) {
      incidentsHtml += '<div class="queue-card-body">' + escapeHtml(truncateText(incident.details.join(' \u00b7 '), 220)) + '</div>';
    }
    incidentsHtml += '<div class="queue-card-actions">';
    incidentsHtml += renderRailActionButton('Ask Hive', {
      'data-rail-action': 'send-prompt',
      'data-rail-prompt':
        'I saw this incident: "' + (incident.summary || incident.kind || 'Incident') +
        '". Give me a crisp brief on what happened, the impact, and whether you need a decision from me.',
    });
    incidentsHtml += '</div>';
    incidentsHtml += '</div>';
  }
  renderQueueCards('queue-incidents', incidentsHtml, 'No active incidents.');
}

function renderTimeline(items) {
  var container = document.getElementById('timeline-list');
  if (!container) return;

  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = '<div class="rail-empty">No timeline items yet.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    html += '<div class="' + toneClass('timeline-card', item.tone) + '">';
    html += '<div class="timeline-card-header">';
    html += '<div class="timeline-card-title">' + escapeHtml(item.title || item.source || 'Timeline item') + '</div>';
    html += '<div class="timeline-card-time">' + escapeHtml(formatMoment(item.ts)) + '</div>';
    html += '</div>';
    html += '<div class="timeline-card-meta">' + escapeHtml(joinMeta([
      item.source || '',
      item.project || 'global',
    ])) + '</div>';
    if (item.details && item.details.length > 0) {
      html += '<div class="timeline-card-details">';
      for (var j = 0; j < item.details.length; j++) {
        html += '<div class="timeline-card-detail">' + escapeHtml(item.details[j]) + '</div>';
      }
      html += '</div>';
    }
    html += '<div class="timeline-card-actions">';
    html += renderRailActionButton('Follow Up', {
      'data-rail-action': 'send-prompt',
      'data-rail-prompt':
        'Follow up on this timeline item: "' + (item.title || item.source || 'Timeline item') +
        '". Give me the important context, what changed, and whether anything needs my attention.',
    });
    html += renderRailActionButton('Open Timeline', {
      'data-rail-action': 'focus-tab',
      'data-rail-tab-target': 'timeline',
      'data-rail-focus-id': 'timeline-list',
    }, true);
    html += '</div>';
    html += '</div>';
  }

  container.innerHTML = html;
}

async function refreshLiveSnapshot() {
  var project = state.sessionProject || state.project;

  try {
    var data = await apiGet(buildApiPath('/live', project));
    state.liveSnapshot = data;
    state.healthSnapshot = buildHealthSnapshot(data);
    renderConsoleActivity(data);
    renderLiveSummary(data);
    renderLiveAgents(data.agents || []);
    updateAgentOverview(data.agents || []);
    renderLeadershipSurface();
  } catch (e) {
    console.error('Live snapshot refresh failed:', e);
    state.liveSnapshot = null;
    state.healthSnapshot = null;
    renderConsoleActivity(null);
    renderLiveSummary(null);
    renderLiveAgents([]);
    updateAgentOverview([]);
    renderLeadershipSurface();
  }
}

async function refreshQueueSnapshot() {
  var project = state.sessionProject || state.project;

  try {
    var data = await apiGet(buildApiPath('/queue', project));
    state.queueSnapshot = data;
    renderQueueSnapshot(data);
    renderLeadershipSurface();
  } catch (e) {
    console.error('Queue snapshot refresh failed:', e);
    state.queueSnapshot = null;
    renderQueueSnapshot(null);
    renderLeadershipSurface();
  }
}

async function refreshTimeline() {
  var project = state.sessionProject || state.project;

  try {
    var data = await apiGet(buildApiPath('/timeline', project, { count: 50 }));
    state.timelineItems = Array.isArray(data.items) ? data.items : [];
    renderTimeline(state.timelineItems);
    renderLeadershipSurface();
  } catch (e) {
    console.error('Timeline refresh failed:', e);
    state.timelineItems = [];
    renderTimeline([]);
    renderLeadershipSurface();
  }
}

function setupProcessLogs() {
  var btn = document.getElementById('process-logs-refresh');
  var backBtn = document.getElementById('process-logs-back');
  var container = document.getElementById('process-logs-content');
  if (btn) {
    btn.addEventListener('click', function () {
      scheduleProcessLogsRefresh(0);
    });
  }
  if (backBtn) {
    backBtn.addEventListener('click', function () {
      clearProcessLogFocus();
    });
  }
  if (container) {
    container.addEventListener('scroll', function () {
      if (!state.processLogsFocus) return;
      var remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
      state.processLogsStickToBottom = remaining < 48;
    });
  }
}

async function refreshProcessLogs() {
  var project = getProjectFocus();
  var params = {};

  if (state.processLogsFocus) {
    params.run = state.processLogsFocus;
    params.lines = 400;
  }

  try {
    var data = await apiGet(buildApiPath('/process-logs', project, params));
    state.processLogsSnapshot = data;
    renderProcessLogs(data);
  } catch (e) {
    console.error('Process logs refresh failed:', e);
    state.processLogsSnapshot = null;
    renderProcessLogs(null);
  }
}


// --- Status Updates ---

function updateTopBar(data) {
  if (!data) return;

  if (data.project) {
    state.project = data.project;
  }
  renderProjectName();

  var dotEl = document.getElementById('supervisor-dot');
  var labelEl = document.getElementById('supervisor-label');

  if (data.supervisor) {
    var supStatus = data.supervisor.status || 'unknown';
    if (dotEl) {
      dotEl.className = 'status-dot';
      if (supStatus === 'active' || supStatus === 'running') {
        dotEl.classList.add('status-dot--active');
      } else if (supStatus === 'error' || supStatus === 'crashed' || supStatus === 'failed') {
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
    var parsed = {
      project: null,
      supervisor: null,
    };

    if (data.result && typeof data.result === 'string') {
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
    console.error('Status refresh failed:', e);
    renderProjectName();
  }
}


// --- Loading State ---

function setSendingState(sending) {
  var input = document.getElementById('console-input');
  var btn = document.getElementById('console-send-btn');
  var busy = Boolean(sending);

  if (input) {
    input.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  if (btn) {
    btn.textContent = busy ? 'Queue' : 'Send';
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
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
  if (!input) return;

  var message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.style.height = 'auto';
  input.focus();

  await submitConsoleMessage(message);
}

async function submitConsoleMessage(message) {
  var normalized = String(message || '').trim();
  if (!normalized) return;

  state.pendingSends += 1;
  setSendingState(state.pendingSends > 0);

  // Show human turn immediately
  addConsoleTurn('human', normalized);

  // Show thinking indicator and loading state
  showThinkingIndicator();

  try {
    var data = await apiPost('/console/send', { message: normalized });

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
    scheduleOperationsRefresh(100);
  } catch (e) {
    removeThinkingIndicator();
    addConsoleTurn('error', 'Error: ' + e.message);
  } finally {
    state.pendingSends = Math.max(0, state.pendingSends - 1);
    setSendingState(state.pendingSends > 0);
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
    scheduleOperationsRefresh(0);
  } catch (e) {
    // Console history endpoint may not exist yet — that is fine
    console.log('Console history not available:', e.message);
    clearConsoleHistory();
  }
}


// --- Session Toolbar Setup ---

function renderConsoleViewToggle() {
  var container = document.getElementById('session-view-toggle');
  if (!container) return;

  var buttons = container.querySelectorAll('[data-console-view]');
  for (var i = 0; i < buttons.length; i++) {
    var button = buttons[i];
    var isActive = button.getAttribute('data-console-view') === state.consoleView;
    if (isActive) {
      button.classList.add('session-view-btn--active');
    } else {
      button.classList.remove('session-view-btn--active');
    }
  }
}

function setConsoleView(view) {
  state.consoleView = view === 'all' ? 'all' : 'conversation';
  renderConsoleViewToggle();
  renderConsoleHistory();
}

function toggleConsoleItemExpanded(key) {
  if (!key) return;
  state.consoleExpanded[key] = !state.consoleExpanded[key];
  renderConsoleHistory();
}

function setupSessionToolbar() {
  var newBtn = document.getElementById('new-session-btn');
  var sessionsBtn = document.getElementById('sessions-btn');
  var briefBtn = document.getElementById('brief-session-btn');
  var viewToggle = document.getElementById('session-view-toggle');

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

  if (briefBtn) {
    briefBtn.addEventListener('click', function () {
      submitConsoleMessage('Give me a short leadership brief: what is moving, what needs my attention, and what can wait?');
    });
  }

  if (viewToggle) {
    viewToggle.addEventListener('click', function (event) {
      var button = event.target && event.target.closest
        ? event.target.closest('[data-console-view]')
        : null;
      if (!button) return;
      setConsoleView(button.getAttribute('data-console-view') || 'conversation');
    });
  }

  renderConsoleViewToggle();
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

function setupLeadershipActions() {
  var attentionBadge = document.getElementById('attention-badge');
  if (attentionBadge) {
    attentionBadge.addEventListener('click', function () {
      focusRailSection('queue', 'queue-attention');
    });
  }

  var healthIndicator = document.getElementById('health-indicator');
  if (healthIndicator) {
    healthIndicator.addEventListener('click', function () {
      focusRailSection('live', 'live-agents');
    });
  }

  var pulseToggle = document.getElementById('pulse-panel-toggle');
  if (pulseToggle) {
    pulseToggle.addEventListener('click', function () {
      state.pulsesCollapsed = !state.pulsesCollapsed;
      renderLeadershipSurface();
    });
  }

  document.addEventListener('click', function (event) {
    var toastDismiss = event.target && event.target.closest
      ? event.target.closest('[data-toast-dismiss]')
      : null;
    if (toastDismiss) {
      dismissToast(toastDismiss.getAttribute('data-toast-dismiss') || '');
      return;
    }

    var railButton = event.target && event.target.closest
      ? event.target.closest('[data-rail-action]')
      : null;

    if (!railButton) return;

    var action = railButton.getAttribute('data-rail-action') || '';

    if (action === 'send-prompt') {
      submitConsoleMessage(railButton.getAttribute('data-rail-prompt') || '');
      return;
    }

    if (action === 'focus-tab') {
      focusRailSection(
        railButton.getAttribute('data-rail-tab-target') || 'live',
        railButton.getAttribute('data-rail-focus-id') || ''
      );
      return;
    }

    if (action === 'log') {
      focusProcessLog(railButton.getAttribute('data-rail-run-id') || '');
    }
  });
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
    scheduleOperationsRefresh(0);
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
  setupLeadershipActions();
  setupRailTabs();
  setRailTab(state.railTab);

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

  renderConsoleActivity(null);
  renderLiveSummary(null);
  renderLiveAgents([]);
  renderQueueSnapshot(null);
  renderTimeline([]);
  renderProcessLogs(null);
  renderLeadershipSurface();

  // Load initial data from API (non-blocking, graceful on failure)
  await refreshStatus();
  await loadConsoleHistory();
  await Promise.all([
    refreshLiveSnapshot(),
    refreshProcessLogs(),
    refreshQueueSnapshot(),
    refreshTimeline(),
  ]);

  setInterval(function () {
    refreshLiveSnapshot();
  }, 2500);

  setInterval(function () {
    refreshProcessLogs();
  }, 2500);

  setInterval(function () {
    refreshQueueSnapshot();
  }, 5000);

  setInterval(function () {
    refreshTimeline();
  }, 8000);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
