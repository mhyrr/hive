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
  sending: false,
  liveSnapshot: null,
  queueSnapshot: null,
  timelineItems: [],
  railTab: 'live',
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

function shouldPreferLatestPreview(item) {
  return item.role === 'assistant' || item.itemType === 'draft' || item.itemType === 'status' || item.source === 'system';
}

function buildCollapsedConsolePreview(item) {
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

function renderProjectName() {
  var projectEl = document.getElementById('project-name');
  if (!projectEl) return;
  projectEl.textContent = state.sessionProject || state.project || '\u2014';
}

function updateSessionProject(project) {
  state.sessionProject = project || null;
  renderProjectName();
  scheduleOperationsRefresh(0);
}

function updateSessionIndicator(sessionId, project) {
  if (state.sessionId !== sessionId) {
    state.consoleExpanded = {};
  }
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
    var item = document.createElement('div');
    item.className = 'agent-dropdown-item';
    item.innerHTML =
      '<span class="agent-dropdown-name">' + escapeHtml(agent.displayName || agent.agentId || 'agent') + '</span>' +
      '<span class="agent-dropdown-persona">' + escapeHtml(agent.persona || '') + '</span>' +
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

function scheduleOperationsRefresh(delay) {
  var base = typeof delay === 'number' ? delay : 180;
  scheduleLiveRefresh(base);
  scheduleQueueRefresh(base + 60);
  scheduleTimelineRefresh(base + 120);
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
  var html = '<div class="live-summary-block">';
  html += '<div class="live-summary-label">Working Now</div>';
  html += '<div class="live-summary-value">' + escapeHtml(snapshot.summary || 'No active work is in motion right now.') + '</div>';
  html += '</div>';
  html += '<div class="live-summary-grid">';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Project</div><div class="live-summary-stat-value">' + escapeHtml(snapshot.project) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Session</div><div class="live-summary-stat-value">' + escapeHtml(snapshot.sessionId || 'none') + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Supervisor</div><div class="live-summary-stat-value">' + escapeHtml(supervisorStatus) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Live Agents</div><div class="live-summary-stat-value">' + escapeHtml(String((snapshot.agents || []).length)) + '</div></div>';
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
    html += '<div class="' + toneClass('status-pill', toneFromStatus(agent.status)) + '">' + escapeHtml(agent.status || 'active') + '</div>';
    html += '</div>';
    html += '<div class="agent-card-meta">' + escapeHtml(joinMeta(meta)) + '</div>';
    if (outputPreview) {
      html += '<div class="agent-card-output">' + escapeHtml(outputPreview) + '</div>';
    } else {
      var emptyOutput = agent.persona === 'steward'
        ? 'Waiting for the first streamed update from the steward.'
        : 'Waiting for the first visible update from this agent.';
      html += '<div class="agent-card-output agent-card-output--empty">' + escapeHtml(emptyOutput) + '</div>';
    }
    html += '</div>';
  }

  container.innerHTML = html;
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

function renderProcessLogs(snapshot) {
  var container = document.getElementById('process-logs-content');
  if (!container) return;

  if (!snapshot || !snapshot.project) {
    container.innerHTML = '<div class="process-logs-empty">No project in focus yet. Start a session or switch project focus.</div>';
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
      snapshot.supervisor.tail || []
    );
  }

  var agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  for (var i = 0; i < agents.length; i++) {
    var agent = agents[i];
    html += renderProcessLogBlock(
      (agent.displayName || agent.agentId || 'agent') + ' \u00b7 ' + snapshot.project,
      joinMeta([
        agent.status || 'active',
        agent.runtime || '',
        agent.runId || '',
        agent.pid ? 'pid ' + agent.pid : '',
      ]),
      agent.tail || []
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
    html += '</div>';
  }

  container.innerHTML = html;
}

async function refreshLiveSnapshot() {
  var project = state.sessionProject || state.project;

  try {
    var data = await apiGet(buildApiPath('/live', project));
    state.liveSnapshot = data;
    renderConsoleActivity(data);
    renderLiveSummary(data);
    renderLiveAgents(data.agents || []);
    renderProcessLogs(data);
    updateAgentOverview(data.agents || []);
  } catch (e) {
    console.error('Live snapshot refresh failed:', e);
    state.liveSnapshot = null;
    renderConsoleActivity(null);
    renderLiveSummary(null);
    renderLiveAgents([]);
    renderProcessLogs(null);
    updateAgentOverview([]);
  }
}

async function refreshQueueSnapshot() {
  var project = state.sessionProject || state.project;

  try {
    var data = await apiGet(buildApiPath('/queue', project));
    state.queueSnapshot = data;
    renderQueueSnapshot(data);
  } catch (e) {
    console.error('Queue snapshot refresh failed:', e);
    state.queueSnapshot = null;
    renderQueueSnapshot(null);
  }
}

async function refreshTimeline() {
  var project = state.sessionProject || state.project;

  try {
    var data = await apiGet(buildApiPath('/timeline', project, { count: 50 }));
    state.timelineItems = Array.isArray(data.items) ? data.items : [];
    renderTimeline(state.timelineItems);
  } catch (e) {
    console.error('Timeline refresh failed:', e);
    state.timelineItems = [];
    renderTimeline([]);
  }
}

function setupProcessLogs() {
  var btn = document.getElementById('process-logs-refresh');
  if (btn) {
    btn.addEventListener('click', function () {
      scheduleOperationsRefresh(0);
    });
  }
}

function refreshProcessLogs() {
  return refreshLiveSnapshot();
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
    scheduleOperationsRefresh(100);
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

  // Load initial data from API (non-blocking, graceful on failure)
  await refreshStatus();
  await loadConsoleHistory();
  await Promise.all([
    refreshLiveSnapshot(),
    refreshQueueSnapshot(),
    refreshTimeline(),
  ]);

  setInterval(function () {
    refreshLiveSnapshot();
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
