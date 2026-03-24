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
  activeAgentExpanded: {},
  consoleView: 'conversation',
  sessionId: null,
  pendingSends: 0,
  liveSnapshot: null,
  cognitionSnapshot: null,
  healthSnapshot: null,
  queueSnapshot: null,
  timelineItems: [],
  railTab: 'live',
  eventStreamFilter: 'all',
  hiveName: null,
  usageChart: null,
  usageHistory: [],
  cognitionRefreshTimer: null,
  agentSignals: {},
  notificationsPrimed: false,
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

// --- Animation Utilities ---

function animateNumber(element, targetValue, duration) {
  if (!element) return;
  var startValue = parseFloat(element.textContent) || 0;
  if (startValue === targetValue) return;
  var startTime = null;
  duration = duration || 400;
  element.classList.add('animate-number');

  function step(timestamp) {
    if (!startTime) startTime = timestamp;
    var progress = Math.min((timestamp - startTime) / duration, 1);
    var eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    var current = startValue + (targetValue - startValue) * eased;
    if (Number.isInteger(targetValue)) {
      element.textContent = Math.round(current);
    } else {
      element.textContent = current.toFixed(targetValue < 1 ? 4 : 2);
    }
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  }

  requestAnimationFrame(step);
}

function showSkeletonLoading(containerId, count) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var html = '';
  for (var i = 0; i < (count || 3); i++) {
    html += '<div class="skeleton skeleton-block"></div>';
  }
  container.innerHTML = html;
}

function getHealthPulseClass() {
  return '';
}


// --- Charts ---

function initUsageChart(containerId) {
  if (typeof uPlot === 'undefined') return null;
  var container = document.getElementById(containerId);
  if (!container) return null;

  container.innerHTML = '';
  var width = container.offsetWidth || 300;

  function formatTokenCount(v) {
    if (v == null) return '—';
    if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  }

  // Tooltip element
  var tooltip = document.createElement('div');
  tooltip.className = 'usage-chart-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);

  var tooltipPlugin = {
    hooks: {
      setCursor: function(u) {
        var idx = u.cursor.idx;
        if (idx == null) {
          tooltip.style.display = 'none';
          return;
        }

        var ts = u.data[0][idx];
        var t3 = u.data[1][idx];
        var t2 = u.data[2][idx];
        var t1 = u.data[3][idx];

        var time = new Date(ts * 1000);
        var timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        tooltip.innerHTML =
          '<div class="usage-tooltip-time">' + timeStr + '</div>' +
          '<div class="usage-tooltip-row usage-tooltip-t3">T3 (frontier): ' + formatTokenCount(t3) + '</div>' +
          '<div class="usage-tooltip-row usage-tooltip-t2">T2 (standard): ' + formatTokenCount(t2) + '</div>' +
          '<div class="usage-tooltip-row usage-tooltip-t1">T1 (local): ' + formatTokenCount(t1) + '</div>';
        tooltip.style.display = 'block';

        var left = u.cursor.left;
        var chartWidth = u.over.offsetWidth;
        // Flip tooltip to left side if near right edge
        if (left > chartWidth - 140) {
          tooltip.style.left = (left - 130) + 'px';
        } else {
          tooltip.style.left = (left + 16) + 'px';
        }
        tooltip.style.top = '4px';
      },
    },
  };

  var opts = {
    width: width,
    height: 130,
    plugins: [tooltipPlugin],
    cursor: { show: true },
    select: { show: false },
    legend: { show: false },
    scales: {
      x: { time: true },
      y: { auto: true, range: function(u, min, max) { return [0, max || 100]; } },
    },
    axes: [
      {
        stroke: 'rgba(168, 154, 136, 0.3)',
        grid: { stroke: 'rgba(255,255,255,0.03)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.03)', width: 1 },
        font: '10px Azeret Mono',
        size: 35,
      },
      {
        stroke: 'rgba(168, 154, 136, 0.3)',
        grid: { stroke: 'rgba(255,255,255,0.03)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.03)', width: 1 },
        font: '10px Azeret Mono',
        size: 50,
        values: function(u, vals) {
          return vals.map(function(v) { return v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'k' : String(v); });
        },
      },
    ],
    series: [
      {},
      {
        label: 'T3',
        stroke: 'rgba(218, 162, 0, 0.8)',
        fill: 'rgba(218, 162, 0, 0.12)',
        width: 2,
        points: { show: true, size: 5 },
      },
      {
        label: 'T2',
        stroke: 'rgba(74, 136, 120, 0.8)',
        fill: 'rgba(74, 136, 120, 0.12)',
        width: 2,
        points: { show: true, size: 5 },
      },
      {
        label: 'T1',
        stroke: 'rgba(88, 136, 176, 0.8)',
        fill: 'rgba(88, 136, 176, 0.12)',
        width: 2,
        points: { show: true, size: 5 },
      },
    ],
  };

  var data = [[], [], [], []];
  var chart = new uPlot(opts, data, container);
  return chart;
}

function updateUsageChart(cognitionSnapshot) {
  if (typeof uPlot === 'undefined') return;

  var usage = cognitionSnapshot && cognitionSnapshot.usage ? cognitionSnapshot.usage : null;
  if (!usage || !usage.tiers) return;

  var now = Math.floor(Date.now() / 1000);
  var t3 = usage.tiers.tier3 && usage.tiers.tier3.totalTokens ? usage.tiers.tier3.totalTokens : 0;
  var t2 = usage.tiers.tier2 && usage.tiers.tier2.totalTokens ? usage.tiers.tier2.totalTokens : 0;
  var t1 = usage.tiers.tier1 && usage.tiers.tier1.totalTokens ? usage.tiers.tier1.totalTokens : 0;

  state.usageHistory.push({ ts: now, t3: t3, t2: t2, t1: t1 });
  if (state.usageHistory.length > 60) {
    state.usageHistory = state.usageHistory.slice(-60);
  }

  var times = [];
  var s1 = [];
  var s2 = [];
  var s3 = [];
  for (var i = 0; i < state.usageHistory.length; i++) {
    var pt = state.usageHistory[i];
    times.push(pt.ts);
    s1.push(pt.t3);
    s2.push(pt.t2);
    s3.push(pt.t1);
  }

  var chartContainer = document.getElementById('usage-chart-container');
  if (!chartContainer) return;

  if (!state.usageChart) {
    state.usageChart = initUsageChart('usage-chart-container');
  }

  if (state.usageChart) {
    state.usageChart.setData([times, s1, s2, s3]);
  }
}

function destroyUsageChart() {
  if (state.usageChart) {
    state.usageChart.destroy();
    state.usageChart = null;
  }
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

function sanitizeStewardLikeText(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<!--\s*turn-meta:.*?-->/g, '')
    .replace(/^[ \t]*\d+\| .*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
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

var FILE_EXTENSIONS_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|yml|yaml|toml|sh|py|rs|go|java|c|cpp|h|rb|sql|graphql|proto|xml|svg|txt)$/i;

function parseFileTarget(target) {
  if (!target) return null;

  var normalized = String(target).trim();

  // Strip trailing punctuation that's not part of the path
  normalized = normalized.replace(/[,;:!?)]+$/, '');

  var line = null;

  // Handle #L123 fragment
  var fragmentIndex = normalized.indexOf('#L');
  if (fragmentIndex !== -1) {
    var fragment = normalized.slice(fragmentIndex + 2);
    normalized = normalized.slice(0, fragmentIndex);
    var fmatch = fragment.match(/^(\d+)/);
    if (fmatch) {
      line = fmatch[1];
    }
  }

  // Handle path:123 line suffix
  var colonLineMatch = normalized.match(/^(.+?):(\d+)(?:-\d+)?$/);
  if (colonLineMatch) {
    normalized = colonLineMatch[1];
    if (!line) line = colonLineMatch[2];
  }

  // Absolute path
  if (normalized[0] === '/') {
    return { path: normalized, line: line };
  }

  // Relative path with recognized extension
  if (FILE_EXTENSIONS_RE.test(normalized) && !normalized.includes(' ') && !normalized.startsWith('http')) {
    return { path: normalized, line: line };
  }

  return null;
}

function buildMarkdownHref(target) {
  if (!target) return null;

  if (/^https?:\/\//i.test(target)) {
    return target;
  }

  // File paths are handled via data-open-path click handler, not navigable URLs
  return null;
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
      var attrs;
      if (fileTarget) {
        attrs = 'class="turn-link turn-link--file" href="#" data-open-path="' + escapeAttr(fileTarget.path) + '"';
        if (fileTarget.line) {
          attrs += ' data-open-line="' + escapeAttr(fileTarget.line) + '"';
        }
      } else {
        attrs = 'class="turn-link" href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer"';
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

var markdownRendererReady = false;

function initMarkdownRenderer() {
  if (markdownRendererReady || typeof marked === 'undefined') return;

  var renderer = new marked.Renderer();

  renderer.link = function (data) {
    var href = data.href || '';
    var text = data.text || '';
    var builtHref = buildMarkdownHref(href);
    var fileTarget = parseFileTarget(href);

    if (fileTarget) {
      var fileAttrs = 'class="turn-link turn-link--file" href="#" data-open-path="' + escapeAttr(fileTarget.path) + '"';
      if (fileTarget.line) {
        fileAttrs += ' data-open-line="' + escapeAttr(fileTarget.line) + '"';
      }
      return '<a ' + fileAttrs + '>' + text + '</a>';
    }

    if (builtHref) {
      return '<a class="turn-link" href="' + escapeAttr(builtHref) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    }

    return '<a class="turn-link" href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  };

  renderer.code = function (data) {
    var code = data.text || '';
    var lang = data.lang || '';
    var highlighted = code;
    if (lang && typeof Prism !== 'undefined' && Prism.languages[lang]) {
      try {
        highlighted = Prism.highlight(code, Prism.languages[lang], lang);
      } catch (e) {
        highlighted = escapeHtml(code);
      }
    } else {
      highlighted = escapeHtml(code);
    }
    return '<pre class="turn-code-block language-' + escapeAttr(lang) + '"><code class="language-' + escapeAttr(lang) + '">' + highlighted + '</code></pre>';
  };

  renderer.codespan = function (data) {
    var raw = data.text || '';
    var fileTarget = parseFileTarget(raw);
    if (fileTarget) {
      var attrs = 'class="turn-link turn-link--file" href="#" data-open-path="' + escapeAttr(fileTarget.path) + '"';
      if (fileTarget.line) {
        attrs += ' data-open-line="' + escapeAttr(fileTarget.line) + '"';
      }
      return '<a ' + attrs + '><code class="turn-code-inline">' + escapeHtml(raw) + '</code></a>';
    }
    return '<code class="turn-code-inline">' + escapeHtml(raw) + '</code>';
  };

  renderer.heading = function (data) {
    var level = data.depth || 2;
    var tag = 'h' + Math.min(level, 4);
    return '<' + tag + ' class="turn-heading turn-heading--' + level + '">' + data.text + '</' + tag + '>';
  };

  renderer.blockquote = function (data) {
    return '<blockquote class="turn-blockquote">' + data.text + '</blockquote>';
  };

  renderer.table = function (data) {
    return '<div class="turn-table-wrap"><table class="turn-table">' + data.header + data.body + '</table></div>';
  };

  renderer.hr = function () {
    return '<hr class="turn-hr">';
  };

  marked.setOptions({
    renderer: renderer,
    gfm: true,
    breaks: true,
  });

  markdownRendererReady = true;
}

function renderMarkdown(text) {
  var source = sanitizeStewardLikeText(String(text || '')).replace(/\r\n/g, '\n').trim();
  if (!source) return '<p class="turn-paragraph"></p>';

  initMarkdownRenderer();

  if (!markdownRendererReady) {
    return renderRichTextFallback(source);
  }

  try {
    return marked.parse(source);
  } catch (e) {
    return renderRichTextFallback(source);
  }
}

function renderRichTextFallback(text) {
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

function renderRichText(text) {
  return renderMarkdown(text);
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
        updateThinkingIndicator(
          event.data.content || '',
          event.data.statusText || '',
          event.data.stage || ''
        );
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
  if (text.indexOf('warn') !== -1 || text.indexOf('block') !== -1) {
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
    return { cssRole: 'system', label: 'buzz' };
  }

  if (role === 'assistant') {
    var name = state.hiveName || 'hive';
    return { cssRole: 'assistant', label: name.toLowerCase() };
  }

  return { cssRole: role, label: role };
}

function getConsoleItemPresentation(item) {
  var presentation = getTurnPresentation(item.role, item.source);

  if (item && item.itemType === 'draft' && item.role === 'assistant' && item.source === 'system') {
    return { cssRole: presentation.cssRole, label: 'buzzing' };
  }

  return presentation;
}

function formatInteger(value) {
  if (value === null || value === undefined || value === '') return '';
  var number = Number(value);
  if (!isFinite(number)) return '';
  return number.toLocaleString('en-US');
}

function formatCompactInteger(value) {
  if (value === null || value === undefined || value === '') return '';
  var number = Number(value);
  if (!isFinite(number)) return '';
  if (Math.abs(number) >= 1000000) return (number / 1000000).toFixed(number % 1000000 === 0 ? 0 : 1) + 'M';
  if (Math.abs(number) >= 1000) return (number / 1000).toFixed(number % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(number));
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

function buildTurnTokenChipLabel(details) {
  if (!details) return '';

  var total = details.totalTokens;
  if (total === null || total === undefined) {
    var derived = 0;
    if (details.inputTokens !== null && details.inputTokens !== undefined) derived += Number(details.inputTokens) || 0;
    if (details.outputTokens !== null && details.outputTokens !== undefined) derived += Number(details.outputTokens) || 0;
    if (details.cacheCreationInputTokens !== null && details.cacheCreationInputTokens !== undefined) derived += Number(details.cacheCreationInputTokens) || 0;
    if (details.cacheReadInputTokens !== null && details.cacheReadInputTokens !== undefined) derived += Number(details.cacheReadInputTokens) || 0;
    total = derived > 0 ? derived : null;
  }

  return total !== null && total !== undefined ? formatInteger(total) + ' tk' : '';
}

function simplifyModelLabel(model) {
  var normalized = String(model || '').trim();
  if (!normalized) return '';

  var slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function buildTurnModelChipLabel(details) {
  if (!details) return '';
  if (details.model) return simplifyModelLabel(details.model);
  if (details.routing && details.routing.handledBy) return details.routing.handledBy;
  return '';
}

function buildTurnTierChipLabel(details) {
  if (!details || !details.routing || !details.routing.tier) return '';
  return details.routing.tier.toUpperCase();
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
    details.routing ||
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

function findLatestConversationReplyItem(items) {
  var allItems = Array.isArray(items) ? items : [];
  var lastHumanIndex = -1;

  for (var i = 0; i < allItems.length; i++) {
    if (allItems[i] && allItems[i].role === 'human') {
      lastHumanIndex = i;
    }
  }

  if (lastHumanIndex === -1) {
    return null;
  }

  for (var j = allItems.length - 1; j > lastHumanIndex; j--) {
    var visibleAssistant = allItems[j];
    if (!visibleAssistant || visibleAssistant.role !== 'assistant') continue;
    if (!isConversationOnlyItem(visibleAssistant)) {
      return null;
    }
  }

  for (var k = allItems.length - 1; k > lastHumanIndex; k--) {
    var candidate = allItems[k];
    if (!candidate || candidate.role !== 'assistant') continue;
    if (candidate.itemType === 'draft' || candidate.itemType === 'status' || candidate.source === 'system') {
      return candidate;
    }
  }

  return null;
}

function getLatestConversationReplyItemFromState() {
  var items = buildConsoleDisplayItems(state.consoleHistory);

  if (state.consoleStream) {
    items.push({
      itemType: 'draft',
      role: 'assistant',
      source: 'system',
      ts: state.consoleStream.ts || nowISO(),
      content: state.consoleStream.content || '',
      statusText: state.consoleStream.statusText || '',
      details: null,
    });
  }

  return findLatestConversationReplyItem(items);
}

function isLiveConversationActivityItem(item) {
  if (!item) return false;
  if (item.itemType === 'draft') return true;
  if (item.itemType !== 'status' && item.source !== 'system') return false;

  var details = item.details || null;
  if (details && details.runs && typeof details.runs.activeCount === 'number' && details.runs.activeCount > 0) {
    return true;
  }

  var statusNotes = details && Array.isArray(details.statusNotes) ? details.statusNotes.join('\n') : '';
  if (/(live steward|persistent steward turn already active|queued .*follow-up|requested stop|still in motion)/i.test(statusNotes)) {
    return true;
  }

  var text = getConsoleItemSourceText(item);
  return /(still in the middle of a live steward turn|interrupting the current live steward draft|still in motion|queued .*follow-up|waiting for the first streamed update|live reply generation is still in progress)/i.test(text);
}

function getLiveConversationActivityItemFromState() {
  var latestReply = getLatestConversationReplyItemFromState();
  return isLiveConversationActivityItem(latestReply) ? latestReply : null;
}

function summarizeConversationActivity(item) {
  if (!item) return '';

  if (item.itemType === 'draft') {
    if (item.statusText) {
      return item.statusText;
    }
    return normalizeMultilineText(item.content)
      ? 'The steward is drafting a live reply.'
      : 'The steward is thinking through your latest message.';
  }

  return truncateText(getConsoleItemSourceText(item) || 'The steward is handling the current conversation.', 220);
}

function buildSyntheticStewardAgent(item) {
  if (!item) return null;

  var details = item.details || null;
  var latestOutput = normalizeMultilineText(getConsoleItemSourceText(item));

  return {
    runId: 'session-steward:' + String(item.ts || nowISO()),
    agentId: 'console',
    displayName: 'steward',
    persona: 'steward',
    descriptor: 'live steward session',
    status: 'active',
    runtime: details && details.runtime ? details.runtime : '',
    model: details && details.model ? details.model : null,
    started: item.ts || nowISO(),
    pid: null,
    taskId: null,
    source: 'session',
    latestOutput: latestOutput || null,
    tail: latestOutput ? splitDisplayLines(latestOutput).slice(-4) : [],
    statusText: item.statusText || '',
  };
}

function buildVisibleLiveAgents(agents) {
  var visibleAgents = Array.isArray(agents) ? agents.slice() : [];
  var pendingConversation = getLiveConversationActivityItemFromState();

  if (!pendingConversation) {
    return visibleAgents;
  }

  for (var i = 0; i < visibleAgents.length; i++) {
    var agent = visibleAgents[i];
    if (!agent) continue;
    if (agent.agentId === 'console' || agent.persona === 'steward') {
      return visibleAgents;
    }
  }

  var steward = buildSyntheticStewardAgent(pendingConversation);
  if (steward) {
    visibleAgents.push(steward);
  }

  return visibleAgents;
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
    title: item.itemType === 'status' || item.itemType === 'draft' ? 'Buzz Detail' : 'Reply Detail',
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

function renderTurnMetaChip(label, modifier) {
  if (!label) return '';

  return '<span class="turn-meta-chip' + (modifier ? ' turn-meta-chip--' + escapeAttr(modifier) : '') + '">' +
    escapeHtml(label) +
    '</span>';
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
  var presentation = getConsoleItemPresentation(item);
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
  html += renderTurnMetaChip(buildTurnTierChipLabel(item.details), 'tier');
  html += renderTurnMetaChip(buildTurnModelChipLabel(item.details), 'model');
  html += renderTurnMetaChip(buildTurnTokenChipLabel(item.details), 'tokens');
  html += renderConsoleExpandChip(item);
  html += renderDetailChip(item);
  html += '<span class="turn-time">' + escapeHtml(formatTime(item.ts || nowISO())) + '</span>';
  html += '</div></div>';

  if (item.itemType === 'draft' && !item.content) {
    var elapsed = item.ts ? getMinutesSince(item.ts) : 0;
    var elapsedStr = elapsed < 1 ? '<1m' : Math.round(elapsed) + 'm';
    html += '<div class="turn-content turn-content--streaming">';
    html += '<div class="turn-streaming-bar"></div>';
    if (item.statusText) {
      html += '<div class="turn-streaming-status">' + escapeHtml(item.statusText) + ' <span class="streaming-cursor"></span></div>';
    } else {
      html += '<div class="turn-streaming-status">Thinking... <span class="streaming-cursor"></span></div>';
    }
    html += '<div class="turn-streaming-elapsed">' + escapeHtml(elapsedStr) + ' elapsed</div>';
    html += '</div>';
  } else {
    var contentHtml = renderRichText(preview && !expanded ? preview.previewText : getConsoleItemSourceText(item));
    html += '<div class="turn-content">' + contentHtml;
    if (item.itemType === 'draft') {
      html += '<span class="streaming-cursor"></span>';
    }
    html += '</div>';
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

  var pendingConversationItem = findLatestConversationReplyItem(items);

  var hiddenCount = 0;
  if (state.consoleView === 'conversation') {
    items = items.filter(function (item) {
      var hidden = isConversationOnlyItem(item);
      if (hidden) hiddenCount += 1;
      return !hidden;
    });

    if (pendingConversationItem && items.indexOf(pendingConversationItem) === -1) {
      items.push(pendingConversationItem);
      hiddenCount = Math.max(0, hiddenCount - 1);
    }
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
        '<div class="console-welcome-prompts">' +
        '<button class="console-welcome-prompt" type="button" data-welcome-prompt="Give me a brief. What have the agents done recently, what is pending, and what needs my attention?">' +
        '<span class="console-welcome-prompt-icon">&#x2728;</span>' +
        '<span class="console-welcome-prompt-text">Get a brief</span>' +
        '</button>' +
        '<button class="console-welcome-prompt" type="button" data-welcome-prompt="What is the current state of the board? Summarize tasks, blockers, and open decisions.">' +
        '<span class="console-welcome-prompt-icon">&#x1F4CB;</span>' +
        '<span class="console-welcome-prompt-text">Board status</span>' +
        '</button>' +
        '<button class="console-welcome-prompt" type="button" data-welcome-prompt="What should I focus on right now? Prioritize the most impactful next step.">' +
        '<span class="console-welcome-prompt-icon">&#x1F3AF;</span>' +
        '<span class="console-welcome-prompt-text">What to focus on</span>' +
        '</button>' +
        '<button class="console-welcome-prompt" type="button" data-welcome-prompt="Review recent agent work. Summarize what each agent accomplished and flag anything that needs review.">' +
        '<span class="console-welcome-prompt-icon">&#x1F50D;</span>' +
        '<span class="console-welcome-prompt-text">Review recent work</span>' +
        '</button>' +
        '<button class="console-welcome-prompt" type="button" data-welcome-prompt="/dream improve the hive status output">' +
        '<span class="console-welcome-prompt-icon">&#x1F319;</span>' +
        '<span class="console-welcome-prompt-text">Launch a dream</span>' +
        '</button>' +
        '</div>' +
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

  var wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.innerHTML = html;
  if (wasNearBottom) {
    container.scrollTop = container.scrollHeight;
  }
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
    statusText: '',
    stage: '',
  };
  renderConsoleHistory();
}

function updateThinkingIndicator(content, statusText, stage) {
  state.consoleStream = {
    ts: (state.consoleStream && state.consoleStream.ts) || nowISO(),
    content: content || '',
    statusText: statusText || '',
    stage: stage || '',
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
  var routingRows = [];
  var routingTraceRows = [];
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
  if (details.routing) {
    if (details.routing.tier) routingRows.push('tier: ' + details.routing.tier);
    if (details.routing.mode) routingRows.push('mode: ' + details.routing.mode);
    if (details.routing.handledBy) routingRows.push('handled by: ' + details.routing.handledBy);
    if (details.routing.lane) routingRows.push('lane: ' + details.routing.lane);
    if (details.routing.fanOutUsed !== null && details.routing.fanOutUsed !== undefined) {
      routingRows.push('fan-out used: ' + formatInteger(details.routing.fanOutUsed));
    }
    if (details.routing.parallelismUsed !== null && details.routing.parallelismUsed !== undefined) {
      routingRows.push('parallelism used: ' + formatInteger(details.routing.parallelismUsed));
    }
    if (details.routing.reusedFreshWorkerOutput !== null && details.routing.reusedFreshWorkerOutput !== undefined) {
      routingRows.push('reused fresh worker output: ' + (details.routing.reusedFreshWorkerOutput ? 'yes' : 'no'));
    }
    if (Array.isArray(details.routing.trace)) {
      for (var routeIndex = 0; routeIndex < details.routing.trace.length; routeIndex++) {
        routingTraceRows.push(details.routing.trace[routeIndex]);
      }
    }
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
    html += '<div class="turn-detail-markdown">' + renderMarkdown(payload.content) + '</div>';
    html += '</section>';
  }
  html += renderDetailSection('Usage', usageRows);
  html += renderDetailSection('Context', contextRows);
  html += renderDetailSection('Routing', routingRows);
  html += renderDetailSection('Route Trace', routingTraceRows);
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

      var welcomePrompt = event.target && event.target.closest
        ? event.target.closest('[data-welcome-prompt]')
        : null;
      if (welcomePrompt) {
        submitConsoleMessage(welcomePrompt.getAttribute('data-welcome-prompt') || '');
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
    state.notificationsPrimed = false;
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
  state.agents = buildVisibleLiveAgents(agents);
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

function toggleBudgetDropdown() {
  var dropdown = document.getElementById('budget-dropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('budget-dropdown--open');
}

function closeBudgetDropdown() {
  var dropdown = document.getElementById('budget-dropdown');
  if (dropdown) dropdown.classList.remove('budget-dropdown--open');
}

function renderBudgetDropdown(snapshot) {
  var list = document.getElementById('budget-dropdown-list');
  if (!list) return;

  var usage = snapshot && snapshot.usage ? snapshot.usage : null;

  if (!usage) {
    list.innerHTML = '<div class="budget-dropdown-empty">No cognition usage yet.</div>';
    return;
  }

  var tiers = ['tier3', 'tier2', 'tier1'];
  var html = '<div class="budget-dropdown-section">';
  for (var i = 0; i < tiers.length; i++) {
    var tierKey = tiers[i];
    var budget = usage.budgets && usage.budgets[tierKey] ? usage.budgets[tierKey] : null;
    var totals = usage.tiers && usage.tiers[tierKey] ? usage.tiers[tierKey] : null;
    var limitLabel = budget && budget.tokenLimit
      ? formatCompactInteger(budget.usedTokens) + '/' + formatCompactInteger(budget.tokenLimit) + ' tk'
      : formatCompactInteger(totals ? totals.totalTokens : 0) + ' tk';
    html += '<div class="budget-dropdown-row">';
    html += '<span class="budget-dropdown-label">' + escapeHtml(tierKey.replace('tier', 'T')) + '</span>';
    html += '<span class="budget-dropdown-value">' + escapeHtml(limitLabel) + '</span>';
    html += '</div>';
  }
  html += '</div>';

  html += '<div class="budget-dropdown-section">';
  html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">project</span><span class="budget-dropdown-value">' + escapeHtml(usage.project || '') + '</span></div>';
  html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">window</span><span class="budget-dropdown-value">' + escapeHtml(String(usage.windowHours || 24) + 'h') + '</span></div>';
  html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">steward wakes</span><span class="budget-dropdown-value">' + escapeHtml(formatInteger(usage.summary && usage.summary.stewardWakes || 0)) + '</span></div>';
  html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">worker runs</span><span class="budget-dropdown-value">' + escapeHtml(formatInteger(usage.summary && usage.summary.workerRuns || 0)) + '</span></div>';
  html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">tier-1 calls</span><span class="budget-dropdown-value">' + escapeHtml(formatInteger(usage.summary && usage.summary.tier1Calls || 0)) + '</span></div>';
  html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">last wake</span><span class="budget-dropdown-value">' + escapeHtml(usage.summary && usage.summary.lastStewardWakeAt ? formatRelativeAge(usage.summary.lastStewardWakeAt) : 'none') + '</span></div>';
  if (usage.summary && usage.summary.estimatedCostUsd !== null && usage.summary.estimatedCostUsd !== undefined) {
    html += '<div class="budget-dropdown-row"><span class="budget-dropdown-label">est. cost</span><span class="budget-dropdown-value">$' + escapeHtml(Number(usage.summary.estimatedCostUsd).toFixed(4)) + '</span></div>';
  }
  html += '</div>';

  list.innerHTML = html;
}

function updateBudgetChip(snapshot) {
  var chip = document.getElementById('budget-chip');
  var label = chip ? chip.querySelector('.topbar-budget-label') : null;
  if (!chip || !label) return;

  renderBudgetDropdown(snapshot);

  var usage = snapshot && snapshot.usage ? snapshot.usage : null;
  var budget = usage && usage.budgets ? usage.budgets.tier3 : null;
  var status = budget ? budget.status : 'unconfigured';
  var text = 'T3 \u2014';

  if (usage && budget) {
    text = budget.tokenLimit
      ? formatCompactInteger(budget.usedTokens) + '/' + formatCompactInteger(budget.tokenLimit) + ' T3'
      : formatCompactInteger((usage.tiers && usage.tiers.tier3 ? usage.tiers.tier3.totalTokens : 0)) + ' T3';
  }

  chip.className = 'topbar-budget topbar-budget--' + status;
  label.textContent = text;
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

function scheduleCognitionRefresh(delay) {
  if (state.cognitionRefreshTimer) {
    clearTimeout(state.cognitionRefreshTimer);
  }

  state.cognitionRefreshTimer = setTimeout(function () {
    state.cognitionRefreshTimer = null;
    refreshCognition();
  }, typeof delay === 'number' ? delay : 220);
}

function scheduleOperationsRefresh(delay) {
  var base = typeof delay === 'number' ? delay : 180;
  scheduleLiveRefresh(base);
  scheduleCognitionRefresh(base + 60);
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


function buildAgentHealth(agent) {
  var key = getAgentKey(agent);
  var status = agent.status || 'active';
  var level = status;
  var tone = toneFromStatus(status);

  return {
    key: key,
    level: level,
    tone: tone,
    label: status,
    agent: agent,
  };
}

function buildHealthSnapshot(liveSnapshot) {
  var agents = liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : [];
  updateAgentSignals(agents);

  var healthAgents = [];
  var activeCount = 0;

  for (var i = 0; i < agents.length; i++) {
    var health = buildAgentHealth(agents[i]);
    healthAgents.push(health);
    var s = (agents[i].status || 'active').toLowerCase();
    if (s === 'active' || s === 'starting') activeCount += 1;
  }

  var aggregate = activeCount > 0 ? 'active' : 'idle';
  var summary = activeCount > 0
    ? countLabel(activeCount, 'active agent', 'active agents')
    : 'No active agents.';

  return {
    aggregate: aggregate,
    tone: activeCount > 0 ? 'info' : 'info',
    agents: healthAgents,
    summary: summary,
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

function renderRailActionButton(label, attrs, quiet, modifier) {
  var html = '<button class="rail-action-btn' + (quiet ? ' rail-action-btn--quiet' : '') + (modifier ? ' ' + modifier : '') + '" type="button"';

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
  var agents = buildVisibleLiveAgents(liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : []);
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
  var activeAgents = buildVisibleLiveAgents(liveSnapshot && Array.isArray(liveSnapshot.agents) ? liveSnapshot.agents : []);
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
      attentionItems[i].kind === 'incident'
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
  var summary = healthSnapshot ? healthSnapshot.summary : 'No active agents.';

  button.className = 'topbar-health topbar-health--' + aggregate;
  button.setAttribute('title', summary);

  if (icon) {
    icon.textContent = aggregate === 'active' ? '●' : '·';
  }
  if (label) {
    label.textContent = aggregate;
  }
}

function renderHealthPill() {
  return '';
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

function renderLeadershipSurface() {
  var leadership = buildLeadershipSnapshot();
  renderHealthIndicator(leadership.health);
  renderAttentionBadge(leadership);
  renderAttentionQueue(leadership);
}

function focusRailSection(tab, focusId) {
  setRailTab(tab || 'live');

  window.requestAnimationFrame(function () {
    var target = focusId ? document.getElementById(focusId) : null;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderConsoleActivity(snapshot) {
  var container = document.getElementById('console-activity');
  if (!container) return;
  var pendingConversation = getLiveConversationActivityItemFromState();

  if (!snapshot || !snapshot.project) {
    if (pendingConversation) {
      container.innerHTML = '<div class="console-activity-summary">' +
        '<div class="console-activity-summary-line">' + escapeHtml(summarizeConversationActivity(pendingConversation)) + '</div>' +
        '<div class="console-activity-summary-meta">steward session active · latest conversation</div>' +
        '</div>';
      return;
    }
    container.innerHTML = '<div class="console-activity-empty">No live hive activity yet.</div>';
    return;
  }

  var summary = truncateText(
    pendingConversation
      ? summarizeConversationActivity(pendingConversation)
      : (snapshot.summary || 'No active work is in motion right now.'),
    220
  );
  var latest = snapshot.activity && snapshot.activity[0] ? snapshot.activity[0] : null;
  var meta = [
    'project ' + snapshot.project,
    snapshot.supervisor ? 'supervisor ' + (snapshot.supervisor.status || 'unknown') : 'supervisor offline',
    pendingConversation
      ? 'steward session active'
      : (snapshot.agents && snapshot.agents.length > 0
        ? countLabel(snapshot.agents.length, 'live agent')
        : 'no live agents'),
    latest ? 'latest ' + formatMoment(latest.ts) : '',
  ];

  if (!pendingConversation) {
    meta = [
      'project ' + snapshot.project,
      snapshot.supervisor ? 'supervisor ' + (snapshot.supervisor.status || 'unknown') : 'supervisor offline',
      snapshot.agents && snapshot.agents.length > 0
      ? countLabel(snapshot.agents.length, 'live agent')
      : 'no live agents',
      latest ? 'latest ' + formatMoment(latest.ts) : '',
    ];
  }

  var html = '<div class="console-activity-summary">';
  html += '<div class="console-activity-summary-line">' + escapeHtml(summary) + '</div>';
  html += '<div class="console-activity-summary-meta">' + escapeHtml(joinMeta(meta)) + '</div>';
  html += '</div>';

  container.innerHTML = html;

  var hasActiveAgents = snapshot && snapshot.agents && snapshot.agents.length > 0;
  container.classList.toggle('console-activity--live', hasActiveAgents || !!pendingConversation);
}

function renderLiveSummary(snapshot) {
  var container = document.getElementById('live-summary');
  if (!container) return;
  var pendingConversation = getLiveConversationActivityItemFromState();
  var visibleAgents = buildVisibleLiveAgents(snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : []);

  if (!snapshot || !snapshot.project) {
    if (pendingConversation) {
      container.innerHTML = '<div class="live-summary-block">' +
        '<div class="live-summary-label">Working Now</div>' +
        '<div class="live-summary-value">' + escapeHtml(summarizeConversationActivity(pendingConversation)) + '</div>' +
        '</div>';
      return;
    }
    container.innerHTML = '<div class="rail-empty">No project in focus yet.</div>';
    return;
  }

  var supervisorStatus = snapshot.supervisor ? (snapshot.supervisor.status || 'unknown') : 'offline';
  var healthSnapshot = state.healthSnapshot;
  var workingNow = pendingConversation
    ? summarizeConversationActivity(pendingConversation)
    : (snapshot.summary || 'No active work is in motion right now.');
  var html = '<div class="live-summary-block">';
  html += '<div class="live-summary-label">Working Now</div>';
  html += '<div class="live-summary-value">' + escapeHtml(workingNow) + '</div>';
  html += '</div>';
  html += '<div class="live-summary-grid">';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Project</div><div class="live-summary-stat-value">' + escapeHtml(snapshot.project) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Session</div><div class="live-summary-stat-value">' + escapeHtml(snapshot.sessionId || 'none') + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Supervisor</div><div class="live-summary-stat-value">' + escapeHtml(supervisorStatus) + '</div></div>';
  html += '<div class="live-summary-stat"><div class="live-summary-stat-label">Live Agents</div><div class="live-summary-stat-value">' + escapeHtml(String(visibleAgents.length)) + '</div></div>';
  html += '</div>';

  container.innerHTML = html;
}

function renderLiveAgents(agents) {
  var container = document.getElementById('live-agents');
  if (!container) return;
  var visibleAgents = buildVisibleLiveAgents(agents);

  if (visibleAgents.length === 0) {
    container.innerHTML = '<div class="rail-empty">No active agents.</div>';
    return;
  }

  var html = '';
  var expandedCount = 0;

  for (var countIndex = 0; countIndex < visibleAgents.length; countIndex++) {
    var countKey = getAgentKey(visibleAgents[countIndex]);
    if (countKey && state.activeAgentExpanded[countKey]) {
      expandedCount += 1;
    }
  }

  html += '<div class="live-agents-toolbar">';
  html += '<div class="live-agents-toolbar-copy">' + escapeHtml(countLabel(visibleAgents.length, 'active agent')) + '</div>';
  html += renderRailActionButton(
    expandedCount === visibleAgents.length ? 'Collapse all' : 'Expand all',
    {
      'data-rail-action': 'toggle-all-agents',
      'data-rail-expanded': expandedCount === visibleAgents.length ? 'false' : 'true',
    },
    true,
  );
  html += '</div>';

  for (var i = 0; i < visibleAgents.length; i++) {
    var agent = visibleAgents[i];
    var agentKey = getAgentKey(agent);
    var expanded = Boolean(agentKey && state.activeAgentExpanded[agentKey]);
    var health = findAgentHealth(state.healthSnapshot, agent);
    var outputDetail = '';
    var descriptor = agent.descriptor || '';
    if (descriptor && agent.persona && descriptor.toLowerCase() === String(agent.persona).toLowerCase()) {
      descriptor = '';
    }
    if (Array.isArray(agent.tail) && agent.tail.length > 0) {
      outputDetail = agent.tail.join('\n');
    } else if (agent.latestOutput) {
      outputDetail = String(agent.latestOutput);
    }
    var meta = [
      agent.runtime || '',
      agent.model || '',
      formatMoment(agent.started),
      agent.pid ? 'pid ' + agent.pid : '',
      agent.taskId ? 'task ' + agent.taskId : '',
    ];
    var collapsedSummary = outputDetail
      ? truncateMultilineText(outputDetail, 180)
      : (agent.statusText || '');
    if (!collapsedSummary) {
      collapsedSummary = agent.persona === 'steward'
        ? 'Waiting for the first streamed update from the steward.'
        : 'Waiting for the first visible update from this agent.';
    }
    var healthPulse = getHealthPulseClass(health);
    html += '<div class="agent-card' + (expanded ? ' agent-card--expanded' : '') + (healthPulse ? ' ' + healthPulse : '') + '" data-persona="' + escapeAttr(agent.persona || 'worker') + '">';
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
    // Model/runtime chips
    html += '<div class="agent-card-chips">';
    if (agent.runtime) {
      html += '<span class="agent-chip agent-chip--runtime">' + escapeHtml(agent.runtime) + '</span>';
    }
    if (agent.model) {
      html += '<span class="agent-chip agent-chip--model">' + escapeHtml(agent.model) + '</span>';
    }
    if (agent.started) {
      var elapsed = getMinutesSince(agent.started);
      var elapsedLabel = elapsed < 1 ? '<1m' : (elapsed < 60 ? Math.round(elapsed) + 'm' : Math.round(elapsed / 60) + 'h');
      html += '<span class="agent-chip agent-chip--duration">' + elapsedLabel + '</span>';
    }
    html += '</div>';

    // Mini timeline bar
    if (agent.started) {
      html += '<div class="agent-timeline-bar" title="Agent lifecycle">';
      html += '<div class="agent-timeline-fill"></div>';
      html += '<div class="agent-timeline-pulse"></div>';
      html += '</div>';
    }

    html += '<div class="agent-card-summary">' + escapeHtml(truncateMultilineText(collapsedSummary, expanded ? 500 : 280)) + '</div>';
    if (expanded && outputDetail) {
      html += '<div class="agent-card-output">' + escapeHtml(outputDetail) + '</div>';
    } else if (expanded) {
      var emptyOutput = agent.statusText || (agent.persona === 'steward'
        ? 'Waiting for the first streamed update from the steward.'
        : 'Waiting for the first visible update from this agent.');
      html += '<div class="agent-card-output agent-card-output--empty">' + escapeHtml(emptyOutput) + '</div>';
    }
    html += '<div class="agent-card-actions">';
    html += renderRailActionButton(expanded ? 'Collapse' : 'Expand', {
      'data-rail-action': 'toggle-agent',
      'data-rail-agent-key': agentKey,
    }, true);
    html += renderRailActionButton('Stop', {
      'data-rail-action': 'stop-agent',
      'data-rail-stop-target': agent.agentId || agent.runId || '',
    }, false, 'rail-action-btn--stop');
    html += '</div>';
    html += '</div>';
  }

  container.innerHTML = html;
}

function findCognitionLane(policy, runtime) {
  if (!policy || !runtime || !Array.isArray(policy.runtimeLanes)) {
    return null;
  }

  for (var i = 0; i < policy.runtimeLanes.length; i++) {
    if (policy.runtimeLanes[i] && policy.runtimeLanes[i].runtime === runtime) {
      return policy.runtimeLanes[i];
    }
  }

  return null;
}

function formatCognitionSelection(runtime, model) {
  if (!runtime) {
    return 'No runtime selected.';
  }

  return model ? runtime + ' (' + model + ')' : runtime + ' (default model)';
}

function formatCognitionExecutionSummary(execution) {
  if (!execution) {
    return 'No runtime lane configured.';
  }

  if (execution.mode === 'persistent-pi') {
    var provider = execution.piRoute && (execution.piRoute.provider || execution.piRoute.providerContext)
      ? (execution.piRoute.provider || execution.piRoute.providerContext)
      : 'provider unset';
    var executedModel = execution.executedModel || 'provider default model';

    return joinMeta([
      'persistent steward via Pi',
      (execution.runtime || 'runtime') + ' -> ' + provider,
      executedModel,
      execution.piRoute && execution.piRoute.authPolicy ? 'auth ' + execution.piRoute.authPolicy : '',
    ]);
  }

  return joinMeta([
    'direct runtime',
    formatCognitionSelection(execution.runtime, execution.executedModel),
    execution.directAuth ? 'auth ' + execution.directAuth : '',
  ]);
}

function formatUsageBudgetLabel(budget, totals) {
  if (!budget) {
    return formatCompactInteger(totals ? totals.totalTokens : 0) + ' tk';
  }

  if (budget.tokenLimit) {
    return formatCompactInteger(budget.usedTokens) + '/' + formatCompactInteger(budget.tokenLimit) + ' tk';
  }

  return formatCompactInteger(totals ? totals.totalTokens : budget.usedTokens) + ' tk';
}

function renderCognitionUsageMeter(label, budget, totals) {
  var used = budget && budget.usedTokens != null ? budget.usedTokens : (totals && totals.totalTokens ? totals.totalTokens : 0);
  var hasBudget = budget && budget.tokenLimit;
  var ratio = hasBudget ? Math.min(1, used / budget.tokenLimit) : 0;
  var percent = hasBudget ? Math.max(used > 0 ? 2 : 0, Math.round(ratio * 100)) : 0;
  var tone = budget ? budget.status : 'unconfigured';
  var tierColor = label === 'T3' ? 'tier3' : (label === 'T2' ? 'tier2' : 'tier1');
  var html = '<div class="cognition-meter cognition-meter--' + tierColor + '">';
  html += '<div class="cognition-meter-header">';
  html += '<div class="cognition-meter-label">' + escapeHtml(label) + '</div>';
  html += '<div class="cognition-meter-value">' + escapeHtml(formatUsageBudgetLabel(budget, totals)) + '</div>';
  html += '</div>';
  if (hasBudget) {
    html += '<div class="cognition-meter-track"><div class="cognition-meter-fill cognition-meter-fill--' + escapeAttr(tone) + ' cognition-meter-fill--' + tierColor + '" style="width:' + percent + '%"></div></div>';
  } else if (used > 0) {
    html += '<div class="cognition-meter-track cognition-meter-track--no-budget"><div class="cognition-meter-fill cognition-meter-fill--' + tierColor + '" style="width:100%"></div></div>';
  } else {
    html += '<div class="cognition-meter-track cognition-meter-track--empty"></div>';
  }
  html += '</div>';
  return html;
}

function renderCognition(snapshot) {
  var container = document.getElementById('cognition-panel');
  if (!container) return;

  destroyUsageChart();

  var policy = snapshot && snapshot.policy ? snapshot.policy : null;
  updateBudgetChip(snapshot);

  if (!policy) {
    container.innerHTML = '<div class="rail-empty">Cognitive routing policy unavailable.</div>';
    return;
  }

  var activeLane = snapshot && snapshot.activeLane
    ? snapshot.activeLane
    : findCognitionLane(policy, snapshot && snapshot.activeSession ? snapshot.activeSession.runtime : null);
  var execution = snapshot && snapshot.activeExecution
    ? snapshot.activeExecution
    : snapshot && snapshot.defaultExecution
      ? snapshot.defaultExecution
      : null;
  var laneLabel = formatCognitionExecutionSummary(execution);
  var laneLabelTitle = snapshot && snapshot.activeExecution ? 'Current Execution' : 'Default Execution';
  var selectionLabel = snapshot && snapshot.activeSession
    ? formatCognitionSelection(snapshot.activeSession.runtime, snapshot.activeSession.model)
    : formatCognitionSelection(policy.defaultRuntime, policy.defaultModel);
  var activeSessionLabel = snapshot && snapshot.activeSession
    ? joinMeta([
      snapshot.activeSession.project || '',
      snapshot.activeSession.sessionId || '',
      'selection ' + selectionLabel,
    ])
    : 'Default selection · ' + selectionLabel;
  var compiled = snapshot && snapshot.compiled ? snapshot.compiled : null;
  var localModels = snapshot && snapshot.localModels ? snapshot.localModels : null;
  var usage = snapshot && snapshot.usage ? snapshot.usage : null;
  var discoveredLocalModels = localModels && Array.isArray(localModels.models)
    ? localModels.models
    : [];
  var html = '<div class="cognition-principle">' +
    escapeHtml(policy.principle || '') +
    '</div>';
  html += '<div class="cognition-grid">';
  html += '<div class="cognition-stat"><div class="cognition-stat-label">Bias</div><div class="cognition-stat-value">' + escapeHtml(policy.bias || 'balanced') + '</div></div>';
  html += '<div class="cognition-stat"><div class="cognition-stat-label">' + escapeHtml(laneLabelTitle) + '</div><div class="cognition-stat-value">' + escapeHtml(laneLabel) + '</div></div>';
  html += '<div class="cognition-stat"><div class="cognition-stat-label">Max Fan-out</div><div class="cognition-stat-value">' + escapeHtml(String(policy.maxFanOut || 0)) + '</div></div>';
  html += '<div class="cognition-stat"><div class="cognition-stat-label">Max Parallel</div><div class="cognition-stat-value">' + escapeHtml(String(policy.maxParallel || 0)) + '</div></div>';
  html += '</div>';
  html += '<div class="cognition-context">' + escapeHtml(joinMeta([
    snapshot && snapshot.project ? 'project ' + snapshot.project : '',
    snapshot && snapshot.activeSession ? 'Live session' : '',
    activeSessionLabel,
  ])) + '</div>';

  if (usage) {
    html += '<div class="cognition-subsection">';
    html += '<div class="cognition-subsection-title">Usage (' + escapeHtml(String(usage.windowHours || 24)) + 'h)</div>';
    html += '<div class="cognition-lane-list">';
    html += '<div class="cognition-row cognition-row--lane">';
    html += '<div class="cognition-row-header">';
    html += '<div class="cognition-row-name">activity</div>';
    html += '<div class="cognition-row-kicker">' + escapeHtml(usage.project || '') + '</div>';
    html += '</div>';
    html += '<div class="cognition-row-body">' + escapeHtml(joinMeta([
      formatInteger(usage.summary && usage.summary.stewardWakes || 0) + ' steward wakes',
      formatInteger(usage.summary && usage.summary.workerRuns || 0) + ' worker runs',
      formatInteger(usage.summary && usage.summary.tier1Calls || 0) + ' tier-1 calls',
    ])) + '</div>';
    html += '</div>';
    html += '<div class="cognition-meter-list">';
    html += renderCognitionUsageMeter('T3', usage.budgets && usage.budgets.tier3, usage.tiers && usage.tiers.tier3);
    html += renderCognitionUsageMeter('T2', usage.budgets && usage.budgets.tier2, usage.tiers && usage.tiers.tier2);
    html += renderCognitionUsageMeter('T1', usage.budgets && usage.budgets.tier1, usage.tiers && usage.tiers.tier1);
    html += '</div>';
    html += '<div id="usage-chart-container" class="cognition-chart"></div>';
    html += '<div class="cognition-row cognition-row--lane">';
    html += '<div class="cognition-row-header">';
    html += '<div class="cognition-row-name">last wake</div>';
    html += '<div class="cognition-row-kicker">' + escapeHtml(usage.summary && usage.summary.lastStewardWakeAt ? formatRelativeAge(usage.summary.lastStewardWakeAt) : 'none') + '</div>';
    html += '</div>';
    html += '<div class="cognition-row-body">' + escapeHtml(
      usage.summary && usage.summary.estimatedCostUsd !== null && usage.summary.estimatedCostUsd !== undefined
        ? 'estimated cost $' + Number(usage.summary.estimatedCostUsd).toFixed(4)
        : 'estimated cost unavailable'
    ) + '</div>';
    html += '</div>';
    html += '</div></div>';
  }

  container.innerHTML = html;
}

function renderQueueCards(containerId, itemsHtml, emptyText) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = itemsHtml || '<div class="rail-empty">' + escapeHtml(emptyText) + '</div>';
}

function renderQueueSnapshot(snapshot) {
  var boardContainer = document.getElementById('board-summary');
  var streamContainer = document.getElementById('event-stream-list');

  // Render board summary
  if (boardContainer) {
    if (!snapshot || !snapshot.project) {
      boardContainer.innerHTML = '<div class="rail-empty">No board state available.</div>';
    } else {
      var approvalCount = Array.isArray(snapshot.approvals) ? snapshot.approvals.length : 0;
      var waitingCount = Array.isArray(snapshot.waitingOnHuman) ? snapshot.waitingOnHuman.length : 0;
      var incidentCount = Array.isArray(snapshot.incidents) ? snapshot.incidents.length : 0;
      var total = approvalCount + waitingCount + incidentCount;
      var boardHtml = '<div class="board-summary-grid">';
      boardHtml += '<div class="board-summary-stat"><div class="board-summary-stat-label">Approvals</div><div class="board-summary-stat-value' + (approvalCount > 0 ? ' board-summary-stat-value--attention' : '') + '">' + approvalCount + '</div></div>';
      boardHtml += '<div class="board-summary-stat"><div class="board-summary-stat-label">Waiting</div><div class="board-summary-stat-value' + (waitingCount > 0 ? ' board-summary-stat-value--attention' : '') + '">' + waitingCount + '</div></div>';
      boardHtml += '<div class="board-summary-stat"><div class="board-summary-stat-label">Incidents</div><div class="board-summary-stat-value' + (incidentCount > 0 ? ' board-summary-stat-value--error' : '') + '">' + incidentCount + '</div></div>';
      boardHtml += '</div>';
      if (total > 0) {
        var aPct = total > 0 ? Math.round((approvalCount / total) * 100) : 0;
        var wPct = total > 0 ? Math.round((waitingCount / total) * 100) : 0;
        var iPct = Math.max(0, 100 - aPct - wPct);
        boardHtml += '<div class="board-visual-bar">';
        if (approvalCount > 0) boardHtml += '<div class="board-visual-segment board-visual-segment--approval" style="width:' + Math.max(aPct, 5) + '%"><span>' + approvalCount + '</span></div>';
        if (waitingCount > 0) boardHtml += '<div class="board-visual-segment board-visual-segment--waiting" style="width:' + Math.max(wPct, 5) + '%"><span>' + waitingCount + '</span></div>';
        if (incidentCount > 0) boardHtml += '<div class="board-visual-segment board-visual-segment--incident" style="width:' + Math.max(iPct, 5) + '%"><span>' + incidentCount + '</span></div>';
        boardHtml += '</div>';
      }
      boardContainer.innerHTML = boardHtml;
    }
  }

  // Build unified event stream
  if (!streamContainer) return;

  if (!snapshot || !snapshot.project) {
    streamContainer.innerHTML = '<div class="rail-empty">No events yet.</div>';
    return;
  }

  var events = [];
  var approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  var waiting = Array.isArray(snapshot.waitingOnHuman) ? snapshot.waitingOnHuman : [];
  var incidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];

  for (var i = 0; i < approvals.length; i++) {
    var approval = approvals[i];
    events.push({
      ts: approval.created || '',
      category: 'attention',
      tone: 'warning',
      title: approval.summary || approval.kind || 'Approval requested',
      actor: approval.requestedBy || '',
      meta: joinMeta([approval.kind || '', approval.project || 'global']),
      body: approval.note || '',
      promptLabel: 'Ask Hive',
      prompt: 'We have a pending approval: "' + (approval.summary || approval.kind) + '". Context, recommendation, and tradeoffs in 3 bullets.',
    });
  }

  for (var j = 0; j < waiting.length; j++) {
    var waitItem = waiting[j];
    events.push({
      ts: waitItem.ts || '',
      category: 'human',
      tone: 'info',
      title: waitItem.summary || waitItem.type || 'Human input needed',
      actor: waitItem.from || '',
      direction: waitItem.from && waitItem.to ? waitItem.from + ' \u2192 ' + waitItem.to : '',
      meta: joinMeta([waitItem.type || 'message']),
      body: '',
      promptLabel: 'Draft Reply',
      prompt: 'We are waiting on a human reply for "' + (waitItem.summary || 'this thread') + '". Draft the reply you recommend.',
    });
  }

  for (var k = 0; k < incidents.length; k++) {
    var incident = incidents[k];
    events.push({
      ts: incident.ts || '',
      category: 'attention',
      tone: incident.severity === 'error' ? 'error' : 'warning',
      title: incident.summary || incident.kind || 'Incident',
      actor: incident.source || '',
      meta: joinMeta([incident.kind || '', incident.routed ? 'routed' : 'unrouted']),
      body: incident.details ? incident.details.join(' \u00b7 ') : '',
      promptLabel: 'Ask Hive',
      prompt: 'I saw this incident: "' + (incident.summary || incident.kind) + '". Brief me on impact and whether you need a decision.',
    });
  }

  // Add live activity items from the live snapshot
  var liveActivity = state.liveSnapshot && Array.isArray(state.liveSnapshot.activity)
    ? state.liveSnapshot.activity : [];
  for (var m = 0; m < liveActivity.length; m++) {
    var act = liveActivity[m];
    events.push({
      ts: act.ts || '',
      category: 'messages',
      tone: act.tone || 'info',
      title: act.title || act.kind || 'Activity',
      actor: act.actor || '',
      meta: joinMeta([act.kind || '', act.source || '']),
      body: act.detail || '',
      promptLabel: 'Follow Up',
      prompt: 'Follow up on this: "' + (act.detail || act.title) + '". What changed, why it matters, and do you need anything from me?',
    });
  }

  // Sort by timestamp descending
  events.sort(function (a, b) { return (b.ts || '').localeCompare(a.ts || ''); });

  // Apply filter
  var activeFilter = state.eventStreamFilter || 'all';
  var filtered = activeFilter === 'all' ? events : events.filter(function (ev) {
    return ev.category === activeFilter;
  });

  if (filtered.length === 0) {
    streamContainer.innerHTML = '<div class="rail-empty">No events match this filter.</div>';
    return;
  }

  var html = '';
  for (var n = 0; n < filtered.length && n < 30; n++) {
    var ev = filtered[n];
    html += '<div class="' + toneClass('queue-card', ev.tone) + '" data-event-category="' + escapeAttr(ev.category) + '">';
    html += '<div class="queue-card-header">';
    html += '<div class="queue-card-title">' + escapeHtml(ev.title) + '</div>';
    html += '<div class="queue-card-time">' + escapeHtml(formatMoment(ev.ts)) + '</div>';
    html += '</div>';
    if (ev.direction) {
      html += '<div class="queue-card-direction">' + escapeHtml(ev.direction) + '</div>';
    }
    html += '<div class="queue-card-meta">' + escapeHtml(joinMeta([ev.actor || '', ev.meta || ''])) + '</div>';
    if (ev.body) {
      html += '<div class="queue-card-body">' + escapeHtml(truncateText(ev.body, 200)) + '</div>';
    }
    html += '<div class="queue-card-actions">';
    html += renderRailActionButton(ev.promptLabel || 'Ask Hive', {
      'data-rail-action': 'send-prompt',
      'data-rail-prompt': ev.prompt || '',
    });
    html += '</div>';
    html += '</div>';
  }

  streamContainer.innerHTML = html;
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

async function refreshCognition() {
  var project = getProjectFocus();

  try {
    var data = await apiGet(buildApiPath('/cognition', project));
    state.cognitionSnapshot = data;
    renderCognition(data);
    updateUsageChart(data);
  } catch (e) {
    console.error('Cognition refresh failed:', e);
    state.cognitionSnapshot = null;
    renderCognition(null);
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

    if (data.hiveName) {
      state.hiveName = data.hiveName;
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

  // Enter to send (no shift), Shift+Enter for newline, Cmd/Ctrl+Enter also sends
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      sendConsoleMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
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

function toggleActiveAgentExpanded(key) {
  if (!key) return;
  state.activeAgentExpanded[key] = !state.activeAgentExpanded[key];
  renderLiveAgents(state.liveSnapshot && Array.isArray(state.liveSnapshot.agents) ? state.liveSnapshot.agents : []);
}

function setAllActiveAgentsExpanded(agents, expanded) {
  var visibleAgents = buildVisibleLiveAgents(agents);
  var next = {};

  for (var i = 0; i < visibleAgents.length; i++) {
    var key = getAgentKey(visibleAgents[i]);
    if (!key) continue;
    next[key] = Boolean(expanded);
  }

  state.activeAgentExpanded = next;
  renderLiveAgents(agents);
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

function setupBudgetDropdown() {
  var chip = document.getElementById('budget-chip');
  if (!chip) return;

  chip.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleBudgetDropdown();
  });
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

  // Event stream filter chips
  var filterContainer = document.getElementById('event-stream-filters');
  if (filterContainer) {
    filterContainer.addEventListener('click', function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('[data-event-filter]') : null;
      if (!chip) return;
      state.eventStreamFilter = chip.getAttribute('data-event-filter') || 'all';
      var chips = filterContainer.querySelectorAll('[data-event-filter]');
      for (var c = 0; c < chips.length; c++) {
        chips[c].classList.toggle('event-filter-chip--active', chips[c] === chip);
      }
      renderQueueSnapshot(state.queueSnapshot);
    });
  }

  document.addEventListener('click', function (event) {
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

    if (action === 'toggle-agent') {
      toggleActiveAgentExpanded(railButton.getAttribute('data-rail-agent-key') || '');
      return;
    }

    if (action === 'toggle-all-agents') {
      setAllActiveAgentsExpanded(
        state.liveSnapshot && Array.isArray(state.liveSnapshot.agents) ? state.liveSnapshot.agents : [],
        railButton.getAttribute('data-rail-expanded') === 'true'
      );
      return;
    }

    if (action === 'stop-agent') {
      stopAgent(railButton, railButton.getAttribute('data-rail-stop-target') || '');
      return;
    }
  });
}


// --- Stop Agent ---

async function stopAgent(btn, target) {
  if (!target) return;
  var originalText = btn.textContent;
  btn.textContent = 'Stopping...';
  btn.disabled = true;

  try {
    var data = await apiPost('/stop', { target: target });
    if (data && data.ok) {
      btn.textContent = 'Stopped';
      addConsoleTurn('assistant', data.message || ('Stopped ' + target), null, 'system');
    } else {
      btn.textContent = 'Failed';
      addConsoleTurn('error', (data && data.error) || ('Failed to stop ' + target));
    }
    refreshStatus();
    scheduleOperationsRefresh(0);
  } catch (e) {
    btn.textContent = 'Error';
    addConsoleTurn('error', 'Stop failed: ' + e.message);
  } finally {
    setTimeout(function () {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  }
}

async function stopAllAgents() {
  var btn = document.getElementById('stop-all-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Stopping...';
  }

  try {
    var data = await apiPost('/stop-all', {});
    var msg = (data && data.message) || 'All agents stopped';
    addConsoleTurn('assistant', msg, null, 'system');
    refreshStatus();
    scheduleOperationsRefresh(0);
  } catch (e) {
    addConsoleTurn('error', 'Stop all failed: ' + e.message);
  } finally {
    if (btn) {
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = '\u23F9 Stop All';
      }, 2000);
    }
  }
}

function setupStopAllButton() {
  var btn = document.getElementById('stop-all-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      stopAllAgents();
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

// --- Command Palette ---

var paletteCommands = [
  { id: 'new-session', label: 'New Session', category: 'Session', shortcut: 'Ctrl+N' },
  { id: 'brief', label: 'Ask for Brief', category: 'Session' },
  { id: 'stop-all', label: 'Stop All Agents', category: 'Control' },
  { id: 'restart-supervisor', label: 'Restart Supervisor', category: 'Control' },
  { id: 'tab-live', label: 'Show Live Panel', category: 'Navigate' },
  { id: 'tab-queue', label: 'Show Queue / Events', category: 'Navigate' },
  { id: 'tab-timeline', label: 'Show Timeline', category: 'Navigate' },
  { id: 'view-conversation', label: 'Conversation View', category: 'View' },
  { id: 'view-all', label: 'Full Session View', category: 'View' },
  { id: 'focus-input', label: 'Focus Input', category: 'Navigate', shortcut: '/' },
];

var paletteSelectedIndex = 0;

function executePaletteCommand(id) {
  closeCommandPalette();
  if (id === 'new-session') { createNewSession(); return; }
  if (id === 'brief') { submitConsoleMessage('Give me a brief leadership update. What have the agents done, what is pending, and what needs my attention?'); return; }
  if (id === 'stop-all') { stopAllAgents(); return; }
  if (id === 'restart-supervisor') { restartSupervisor(); return; }
  if (id === 'tab-live') { setRailTab('live'); return; }
  if (id === 'tab-queue') { setRailTab('queue'); return; }
  if (id === 'tab-timeline') { setRailTab('timeline'); return; }
  if (id === 'view-conversation') { setConsoleView('conversation'); return; }
  if (id === 'view-all') { setConsoleView('all'); return; }
  if (id === 'focus-input') { var inp = document.getElementById('console-input'); if (inp) inp.focus(); return; }

  // Dynamic agent stop commands
  if (id.indexOf('stop-agent-') === 0) {
    var agentId = id.replace('stop-agent-', '');
    apiPost('/stop', { target: agentId }).catch(function () {});
    return;
  }
}

function getDynamicCommands() {
  var cmds = [];
  var agents = state.liveSnapshot && Array.isArray(state.liveSnapshot.agents) ? state.liveSnapshot.agents : [];
  for (var i = 0; i < agents.length; i++) {
    var agent = agents[i];
    cmds.push({
      id: 'stop-agent-' + (agent.agentId || agent.runId),
      label: 'Stop ' + (agent.displayName || agent.agentId || 'agent'),
      category: 'Agents',
    });
  }
  return cmds;
}

function fuzzyMatch(query, text) {
  if (!query) return { score: 1, matched: true };
  var q = query.toLowerCase();
  var t = text.toLowerCase();
  if (t === q) return { score: 100, matched: true };
  if (t.indexOf(q) === 0) return { score: 80, matched: true };
  if (t.indexOf(q) > 0) return { score: 60, matched: true };

  // character-by-character fuzzy
  var qi = 0;
  for (var ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi === q.length) return { score: 40, matched: true };
  return { score: 0, matched: false };
}

function renderPaletteResults(query) {
  var container = document.getElementById('command-palette-results');
  if (!container) return;

  var allCommands = paletteCommands.concat(getDynamicCommands());
  var results = [];
  for (var i = 0; i < allCommands.length; i++) {
    var cmd = allCommands[i];
    var match = fuzzyMatch(query, cmd.label);
    if (match.matched) {
      results.push({ cmd: cmd, score: match.score });
    }
  }
  results.sort(function (a, b) { return b.score - a.score; });

  if (results.length === 0) {
    container.innerHTML = '<div class="command-palette-empty">No matching commands</div>';
    paletteSelectedIndex = -1;
    return;
  }

  paletteSelectedIndex = Math.min(paletteSelectedIndex, results.length - 1);
  if (paletteSelectedIndex < 0) paletteSelectedIndex = 0;

  var html = '';
  for (var j = 0; j < results.length; j++) {
    var r = results[j];
    var selected = j === paletteSelectedIndex;
    html += '<div class="command-palette-result' + (selected ? ' command-palette-result--selected' : '') + '" data-command-id="' + escapeAttr(r.cmd.id) + '">';
    html += '<div class="command-palette-result-label">' + escapeHtml(r.cmd.label) + '</div>';
    html += '<div class="command-palette-result-meta">';
    html += '<span class="command-palette-result-category">' + escapeHtml(r.cmd.category) + '</span>';
    if (r.cmd.shortcut) {
      html += '<span class="command-palette-result-shortcut">' + escapeHtml(r.cmd.shortcut) + '</span>';
    }
    html += '</div>';
    html += '</div>';
  }
  container.innerHTML = html;
}

function openCommandPalette() {
  var palette = document.getElementById('command-palette');
  var input = document.getElementById('command-palette-input');
  if (!palette || !input) return;
  palette.hidden = false;
  input.value = '';
  paletteSelectedIndex = 0;
  renderPaletteResults('');
  requestAnimationFrame(function () { input.focus(); });
}

function closeCommandPalette() {
  var palette = document.getElementById('command-palette');
  if (palette) palette.hidden = true;
}

function setupCommandPalette() {
  var input = document.getElementById('command-palette-input');
  var backdrop = document.getElementById('command-palette-backdrop');
  var results = document.getElementById('command-palette-results');

  if (input) {
    input.addEventListener('input', function () {
      paletteSelectedIndex = 0;
      renderPaletteResults(input.value);
    });

    input.addEventListener('keydown', function (e) {
      var items = document.querySelectorAll('.command-palette-result');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        paletteSelectedIndex = Math.min(paletteSelectedIndex + 1, items.length - 1);
        renderPaletteResults(input.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        paletteSelectedIndex = Math.max(paletteSelectedIndex - 1, 0);
        renderPaletteResults(input.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var selected = document.querySelector('.command-palette-result--selected');
        if (selected) {
          executePaletteCommand(selected.getAttribute('data-command-id') || '');
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeCommandPalette();
      }
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', closeCommandPalette);
  }

  if (results) {
    results.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.command-palette-result') : null;
      if (item) {
        executePaletteCommand(item.getAttribute('data-command-id') || '');
      }
    });
  }
}


function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function (e) {
    // Ctrl+N (or Cmd+N on Mac): new session
    var modKey = isMac() ? e.metaKey : e.ctrlKey;
    if (modKey && e.key === 'n') {
      e.preventDefault();
      createNewSession();
    }

    // Cmd+K / Ctrl+K: open command palette
    if (modKey && e.key === 'k') {
      e.preventDefault();
      openCommandPalette();
    }
  });
}


// --- Close dropdowns on outside click ---

function setupGlobalClickHandler() {
  document.addEventListener('click', function () {
    closeAgentDropdown();
    closeBudgetDropdown();
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
  setupBudgetDropdown();
  setupLeadershipActions();
  setupRailTabs();
  setRailTab(state.railTab);

  // Set up restart button
  setupRestartButton();

  // Set up stop all button
  setupStopAllButton();

  // Set up console detail modal
  setupConsoleDetailModal();

  // Set up keyboard shortcuts
  setupKeyboardShortcuts();

  // Set up command palette
  setupCommandPalette();

  // Close dropdowns on outside click
  setupGlobalClickHandler();

  // Connect WebSocket for real-time updates
  connectWebSocket();

  renderConsoleActivity(null);
  renderLiveSummary(null);
  renderLiveAgents([]);
  renderCognition(null);
  renderQueueSnapshot(null);
  renderTimeline([]);
  renderLeadershipSurface();

  // Load initial data from API (non-blocking, graceful on failure)
  await refreshStatus();
  await loadConsoleHistory();
  await Promise.all([
    refreshLiveSnapshot(),
    refreshCognition(),
    refreshQueueSnapshot(),
    refreshTimeline(),
  ]);

  setInterval(function () {
    refreshLiveSnapshot();
  }, 2500);

  setInterval(function () {
    refreshCognition();
  }, 10000);

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
