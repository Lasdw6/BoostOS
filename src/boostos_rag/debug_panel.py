"""
boostos_rag.debug_panel — HTML debug panel served at GET /debug.

Single-page app: vanilla HTML/CSS/JS, no CDN deps (safe for offline WSL use).
Auto-refreshes every 5 seconds. Sections:
  - Feature toggles
  - Active agents + per-agent tool call history (expandable)
  - API usage (today's tokens + cost by agent)
  - System status
"""
from __future__ import annotations

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BoostOS Debug</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  background: #0d1117;
  color: #c9d1d9;
  padding: 20px;
}
h1 { color: #58a6ff; font-size: 18px; margin-bottom: 4px; }
.subtitle { color: #8b949e; margin-bottom: 24px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 16px;
}
.card-wide { grid-column: 1 / -1; }
.card h2 {
  color: #e6edf3;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #21262d;
}
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  color: #8b949e;
  font-weight: normal;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 4px 8px 8px 0;
  border-bottom: 1px solid #21262d;
}
td { padding: 6px 8px 6px 0; border-bottom: 1px solid #161b22; vertical-align: top; }
tr:last-child td { border-bottom: none; }
.badge {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
}
.badge-green  { background: #1a3a1a; color: #3fb950; border: 1px solid #238636; }
.badge-red    { background: #3a1a1a; color: #f85149; border: 1px solid #da3633; }
.badge-yellow { background: #3a2f1a; color: #e3b341; border: 1px solid #9e6a03; }
.badge-blue   { background: #1a2a3a; color: #58a6ff; border: 1px solid #1f6feb; }
.badge-gray   { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
.toggle-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #c9d1d9;
  cursor: pointer;
  padding: 2px 10px;
  font-family: inherit;
  font-size: 12px;
  transition: border-color 0.15s;
}
.toggle-btn:hover { border-color: #58a6ff; color: #58a6ff; }
.agent-row { cursor: pointer; }
.agent-row:hover td { background: #1c2128; }
.history-row td { background: #0d1117; font-size: 12px; }
.history-row { display: none; }
.history-row.open { display: table-row; }
.history-inner { padding: 8px; }
.history-call {
  border: 1px solid #21262d;
  border-radius: 4px;
  margin-bottom: 6px;
  overflow: hidden;
}
.history-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #161b22;
  cursor: pointer;
}
.history-call-body {
  display: none;
  padding: 8px 10px;
  background: #0d1117;
  border-top: 1px solid #21262d;
}
.history-call-body.open { display: block; }
.history-call-body pre {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  color: #8b949e;
  max-height: 200px;
  overflow-y: auto;
}
.stat-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
.stat-label { color: #8b949e; }
.stat-value { color: #e6edf3; font-weight: 600; }
.refresh-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #8b949e;
  font-size: 11px;
  margin-bottom: 16px;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: #3fb950; display: inline-block; margin-right: 6px; }
.dot.stale { background: #e3b341; }
.err { color: #f85149; padding: 8px; }
</style>
</head>
<body>

<h1>BoostOS Debug</h1>
<div class="subtitle">Real-time feature flags, agent activity, and API usage</div>

<div class="refresh-bar">
  <span><span class="dot" id="live-dot"></span><span id="refresh-status">Loading…</span></span>
  <span id="refresh-time"></span>
</div>

<div class="grid">

  <!-- Features -->
  <div class="card">
    <h2>Feature Flags</h2>
    <div id="features-content"><span class="err">Loading…</span></div>
  </div>

  <!-- System Status -->
  <div class="card">
    <h2>System Status</h2>
    <div id="status-content"><span class="err">Loading…</span></div>
  </div>

  <!-- Agents -->
  <div class="card card-wide">
    <h2>Agents</h2>
    <div id="agents-content"><span class="err">Loading…</span></div>
  </div>

  <!-- API Usage -->
  <div class="card card-wide">
    <h2>API Usage — Today</h2>
    <div id="usage-content"><span class="err">Loading…</span></div>
  </div>

</div>

<script>
const BASE = '';

function badge(text, color) {
  return `<span class="badge badge-${color}">${text}</span>`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

// ── Features ──────────────────────────────────────────────────────────────────

async function loadFeatures() {
  const el = document.getElementById('features-content');
  try {
    const r = await fetch('/features');
    const data = await r.json();
    const features = data.features || [];
    let html = '<table><tr><th>Feature</th><th>State</th><th></th></tr>';
    for (const f of features) {
      const b = f.enabled ? badge('enabled', 'green') : badge('disabled', 'red');
      const btn = f.enabled
        ? `<button class="toggle-btn" onclick="toggleFeature('${f.name}', false)">disable</button>`
        : `<button class="toggle-btn" onclick="toggleFeature('${f.name}', true)">enable</button>`;
      html += `<tr>
        <td><strong>${f.name}</strong><br><span style="color:#8b949e;font-size:11px">${f.description}</span></td>
        <td>${b}</td>
        <td>${btn}</td>
      </tr>`;
    }
    html += '</table>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<span class="err">Failed to load features: ${e}</span>`;
  }
}

async function toggleFeature(name, enabled) {
  await fetch(`/features/${name}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled}),
  });
  await loadFeatures();
}

// ── Status ────────────────────────────────────────────────────────────────────

async function loadStatus() {
  const el = document.getElementById('status-content');
  try {
    const r = await fetch('/status');
    const d = await r.json();
    const statusBadge = d.status === 'ready' ? badge('ready', 'green') : badge(d.status, 'yellow');
    el.innerHTML = `
      <div class="stat-row"><span class="stat-label">RAG daemon</span><span>${statusBadge}</span></div>
      <div class="stat-row"><span class="stat-label">Version</span><span class="stat-value">${d.version}</span></div>
      <div class="stat-row"><span class="stat-label">Chunks indexed</span><span class="stat-value">${(d.total_chunks||0).toLocaleString()}</span></div>
      <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${fmtUptime(d.uptime_seconds)}</span></div>
      <div class="stat-row"><span class="stat-label">Watched dirs</span><span class="stat-value">${(d.watched_dirs||[]).length}</span></div>
      <div class="stat-row"><span class="stat-label">Embedding model</span><span class="stat-value">${d.embedding_model||'—'}</span></div>
    `;
  } catch(e) {
    el.innerHTML = `<span class="err">Failed to load status: ${e}</span>`;
  }
}

function fmtUptime(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Agents ────────────────────────────────────────────────────────────────────

const _openAgents = new Set();

async function loadAgents() {
  const el = document.getElementById('agents-content');
  try {
    const r = await fetch('/agents');
    const data = await r.json();
    const agents = data.agents || [];
    if (agents.length === 0) {
      el.innerHTML = '<span style="color:#8b949e">No registered agents. Run: boostos-agent register --name "my-agent"</span>';
      return;
    }
    let html = '<table><tr><th>ID</th><th>Name</th><th>Model</th><th>Status</th><th>Last seen</th><th>Workspace</th></tr>';
    for (const a of agents) {
      const statusColor = a.status === 'active' ? 'green' : a.status === 'stale' ? 'yellow' : 'gray';
      const ws = (a.workspace || '').replace(/^\/home\/[^/]+/, '~');
      html += `<tr class="agent-row" onclick="toggleAgent('${a.id}')">
        <td style="font-family:monospace;color:#8b949e">${a.id}</td>
        <td><strong>${a.name}</strong></td>
        <td style="color:#8b949e">${a.model||'—'}</td>
        <td>${badge(a.status, statusColor)}</td>
        <td style="color:#8b949e">${fmtTime(a.last_seen)}</td>
        <td style="color:#8b949e;font-size:11px">${ws||'—'}</td>
      </tr>
      <tr class="history-row ${_openAgents.has(a.id) ? 'open' : ''}" id="hist-${a.id}">
        <td colspan="6"><div class="history-inner" id="hist-inner-${a.id}">Loading…</div></td>
      </tr>`;
    }
    html += '</table>';
    el.innerHTML = html;
    // Reload open history panes
    for (const id of _openAgents) {
      loadAgentHistory(id);
    }
  } catch(e) {
    el.innerHTML = `<span class="err">Failed to load agents: ${e}</span>`;
  }
}

async function toggleAgent(agentId) {
  const row = document.getElementById(`hist-${agentId}`);
  if (!row) return;
  if (_openAgents.has(agentId)) {
    _openAgents.delete(agentId);
    row.classList.remove('open');
  } else {
    _openAgents.add(agentId);
    row.classList.add('open');
    await loadAgentHistory(agentId);
  }
}

async function loadAgentHistory(agentId) {
  const el = document.getElementById(`hist-inner-${agentId}`);
  if (!el) return;
  try {
    const r = await fetch(`/agents/${agentId}/tools?limit=20`);
    const data = await r.json();
    const calls = data.calls || [];
    if (calls.length === 0) {
      el.innerHTML = '<span style="color:#8b949e">No tool calls recorded yet.</span>';
      return;
    }
    let html = '';
    for (const c of calls) {
      const ms = c.latency_ms != null ? `${c.latency_ms}ms` : '—';
      const statusBadge = c.status === 'ok' ? badge('ok','green') : badge(c.status,'red');
      html += `<div class="history-call">
        <div class="history-call-header" onclick="this.nextElementSibling.classList.toggle('open')">
          <code style="color:#58a6ff">${c.tool_name}</code>
          <span style="color:#8b949e;font-size:11px">${fmtTime(c.ts)}</span>
          <span style="color:#8b949e;font-size:11px">${ms}</span>
          ${statusBadge}
        </div>
        <div class="history-call-body">
          <div style="color:#8b949e;font-size:11px;margin-bottom:4px">INPUT</div>
          <pre>${escHtml(c.input_text||'')}</pre>
          <div style="color:#8b949e;font-size:11px;margin: 8px 0 4px">OUTPUT</div>
          <pre>${escHtml(c.output_text||'')}</pre>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<span class="err">Failed to load history: ${e}</span>`;
  }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── API Usage ─────────────────────────────────────────────────────────────────

async function loadUsage() {
  const el = document.getElementById('usage-content');
  try {
    const r = await fetch('/usage/today');
    const data = await r.json();
    const rows = data.rows || [];
    const totals = data.totals || {};
    if (rows.length === 0) {
      el.innerHTML = '<span style="color:#8b949e">No API calls recorded today.</span>';
      return;
    }
    let html = `
      <div style="margin-bottom:12px;padding:10px;background:#0d1117;border-radius:6px;display:flex;gap:32px">
        <div><span class="stat-label">Total tokens </span><span class="stat-value">${fmtTokens((totals.input_tok||0)+(totals.output_tok||0))}</span></div>
        <div><span class="stat-label">Calls </span><span class="stat-value">${totals.calls||0}</span></div>
        <div><span class="stat-label">Cost </span><span class="stat-value">$${(totals.cost_usd||0).toFixed(3)}</span></div>
      </div>
      <table>
        <tr><th>Provider</th><th>Model</th><th>Agent</th><th>Calls</th><th>Input</th><th>Output</th><th>Cost</th></tr>`;
    for (const row of rows) {
      html += `<tr>
        <td>${row.provider}</td>
        <td style="color:#8b949e">${row.model}</td>
        <td style="color:#8b949e">${row.agent_id||'—'}</td>
        <td>${row.calls}</td>
        <td>${fmtTokens(row.input_tok)}</td>
        <td>${fmtTokens(row.output_tok)}</td>
        <td>$${row.cost_usd.toFixed(3)}</td>
      </tr>`;
    }
    html += '</table>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<span class="err">Failed to load usage: ${e}</span>`;
  }
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

let _tick = 0;
async function refresh() {
  _tick++;
  document.getElementById('live-dot').className = 'dot';
  document.getElementById('refresh-status').textContent = 'Live';
  document.getElementById('refresh-time').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
  await Promise.all([loadFeatures(), loadStatus(), loadAgents(), loadUsage()]);
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
"""


def render() -> str:
    return _HTML
