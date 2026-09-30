// 7ex Parser - Popup v6 (EN + Key Management)
const $ = id => document.getElementById(id);

let isRunning = false;
let players = {};
let blacklist = [];
let whitelist = [];
let updateTimer = null;
let audioCtx = null;

function getAudioCtx() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function playPassSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;

  const start = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.16, start);
  master.connect(ctx.destination);

  const bark = (at, high, low) => {
    const t = start + at;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(high, t);
    osc.frequency.exponentialRampToValueAtTime(low, t + 0.11);
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(620, t);
    filter.Q.setValueAtTime(2.2, t);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + 0.18);

    const dur = 0.12;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.35;
    const noise = ctx.createBufferSource();
    const noiseFilter = ctx.createBiquadFilter();
    const noiseGain = ctx.createGain();
    noise.buffer = buffer;
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(900, t);
    noiseGain.gain.setValueAtTime(0.001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.04, t + 0.012);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(t);
    noise.stop(t + dur);
  };

  bark(0.00, 230, 90);
  bark(0.18, 190, 80);
}

document.addEventListener('pointerdown', () => getAudioCtx(), { once: true, capture: true });
document.addEventListener('keydown', () => getAudioCtx(), { once: true, capture: true });

// ============================================================
// TABS
// ============================================================
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'keys') renderKeys();
  });
});

// ============================================================
// LOG
// ============================================================
function addLog(msg, type = 'info') {
  const box = $('logBox');
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `[${time}] ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 150) box.removeChild(box.firstChild);
}

// ============================================================
// FORMAT
// ============================================================
function formatTime(seconds) {
  if (!seconds) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatValue(val) {
  if (val === null || val === undefined) return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  if (n === 0) return '$0';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(0);
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inventoryStatusLabel(status) {
  const labels = {
    checking: 'checking',
    ok: 'Buff',
    partial: 'Buff partial',
    empty: 'empty',
    private: 'private',
    rate_limited: 'rate limit',
    price_data_unavailable: 'no Buff',
    pricing_unavailable: 'price source down',
    no_priced_items: 'no price',
    no_steam_id: 'no Steam',
    invalid_steam_id: 'bad Steam ID',
    steam_error: 'Steam error',
    inventory_unavailable: 'inventory down',
    no_data: 'no data',
  };
  return labels[status] || status || 'no data';
}

function inventoryDetails(p = {}) {
  const inv = p.inventory || {};
  const status = p.checking ? 'checking' : (inv.status || p.inventoryStatus);
  const total = inv.totalItems ?? p.totalItems ?? 0;
  const priced = inv.pricedItems ?? p.pricedItems ?? 0;
  const source = `${inv.source || p.inventorySource || 'Buff163'}${inv.provider ? '@' + inv.provider : ''}`;

  if (p.cs2Value !== null && p.cs2Value !== undefined) {
    return {
      short: total ? `${source} ${priced}/${total}` : source,
      title: `CS2 inventory: ${formatValue(p.cs2Value)} · ${priced}/${total} items priced via ${source}`,
    };
  }

  const label = inventoryStatusLabel(status);
  return {
    short: label,
    title: `CS2 inventory: ${label}${total ? ` · ${priced}/${total} items priced via ${source}` : ''}`,
  };
}

// ============================================================
// RENDER PLAYERS
// ============================================================
function renderPlayers() {
  const list = $('playersList');
  const entries = Object.entries(players);

  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">${isRunning ? 'Waiting for players...' : 'Start the parser to monitor the lobby'}</div>`;
    $('statPassed').textContent = '0';
    $('statKicked').textContent = '0';
    $('statChecking').textContent = '0';
    return;
  }

  let passed = 0, kicked = 0, checking = 0;

  list.innerHTML = entries.map(([nick, p]) => {
    let rowClass = 'checking';
    let statusText = '...';
    let statusClass = 'status-checking';
    let valueColor = '';

    if (p.kicked) {
      rowClass = 'kicked'; statusText = 'KICK'; statusClass = 'status-kicked'; kicked++;
    } else if (p.whitelisted) {
      rowClass = 'whitelist'; statusText = 'WHITE'; statusClass = 'status-whitelist'; passed++;
    } else if (p.passed) {
      rowClass = 'passed'; statusText = 'PASS'; statusClass = 'status-passed'; passed++;
    } else if (p.noData) {
      rowClass = 'no-data'; statusText = 'NO DATA'; statusClass = 'status-nodata';
    } else {
      checking++;
    }

    const filters = window._filters || {};
    if (p.cs2Value !== null && p.cs2Value !== undefined) {
      const v = parseFloat(p.cs2Value);
      const min = parseFloat(filters.minCs2Value) || 0;
      const max = parseFloat(filters.maxCs2Value) || 999999;
      valueColor = (v >= min && v <= max) ? 'green' : 'red';
    }

    const timeInLobby = p.joinTime ? Math.floor((Date.now() - p.joinTime) / 1000) : 0;
    const invInfo = inventoryDetails(p);
    const valueClass = !p.cs2Value && p.cs2Value !== 0 ? 'na' : valueColor;

    return `<div class="player-row ${rowClass}">
      <div class="player-nick" title="${escHtml(nick)}">${escHtml(nick)}</div>
      <div class="player-value ${valueClass}" title="${escHtml(invInfo.title)}">
        <div class="player-value-main">${formatValue(p.cs2Value)}</div>
        <div class="player-value-sub">${escHtml(invInfo.short)}</div>
      </div>
      <div class="player-time">${formatTime(timeInLobby)}</div>
      <div class="player-status ${statusClass}">${statusText}</div>
    </div>`;
  }).join('');

  $('statPassed').textContent = passed;
  $('statKicked').textContent = kicked;
  $('statChecking').textContent = checking;
}

// ============================================================
// BACKGROUND EVENTS
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'parserEvent') return;
  const d = msg.data;

  switch (d.type) {
    case 'passed':
      players[d.nickname] = {
        ...players[d.nickname],
        passed: true, checking: false, kicked: false,
        cs2Value: d.cs2Value,
        steamId: d.steamId,
        inventory: d.inventory,
        inventoryStatus: d.inventory?.status,
        joinTime: players[d.nickname]?.joinTime || Date.now(),
      };
      addLog(`✅ ${d.nickname} — PASS · ${formatValue(d.cs2Value)} · ${inventoryDetails(players[d.nickname]).short}`, 'success');
      playPassSound();
      break;

    case 'noData':
      players[d.nickname] = {
        ...players[d.nickname],
        noData: true, checking: false, passed: false, kicked: false,
        cs2Value: null,
        steamId: d.steamId,
        inventory: d.inventory,
        inventoryStatus: d.inventory?.status || 'no_data',
        joinTime: players[d.nickname]?.joinTime || Date.now(),
      };
      addLog(`ℹ️ ${d.nickname} — NO DATA · ${inventoryDetails(players[d.nickname]).short}`, 'warn');
      break;

    case 'kicked':
      players[d.nickname] = {
        ...players[d.nickname],
        kicked: true, checking: false, passed: false,
        cs2Value: d.cs2Value,
        inventory: d.inventory,
        inventoryStatus: d.inventory?.status,
        joinTime: players[d.nickname]?.joinTime || Date.now(),
      };
      addLog(`🚫 ${d.nickname} — KICKED · ${formatValue(d.cs2Value)} · ${inventoryDetails(players[d.nickname]).short} (${d.reason || 'filter'})`, 'error');
      break;

    case 'kickFailed':
      addLog(`⚠️ ${d.nickname} — kick failed (open the FACEIT tab)`, 'warn');
      showKickWarn(d.nickname);
      break;

    case 'checking':
      if (!players[d.nickname]) players[d.nickname] = { joinTime: Date.now() };
      players[d.nickname].checking = true;
      players[d.nickname].inventoryStatus = 'checking';
      addLog(`🔍 ${d.nickname} — checking...`, 'info');
      break;

    case 'whitelisted':
      players[d.nickname] = {
        ...players[d.nickname],
        whitelisted: true, checking: false,
        joinTime: players[d.nickname]?.joinTime || Date.now(),
      };
      addLog(`⭐ ${d.nickname} — Whitelist`, 'info');
      break;

    case 'autoBanned':
      addLog(`🔨 ${d.nickname} — AUTO-BAN${d.count && d.threshold ? ` (${d.count}/${d.threshold} filter fails)` : ''}`, 'error');
      if (!blacklist.includes(d.nickname.toLowerCase())) {
        blacklist.push(d.nickname.toLowerCase());
        renderList(blacklist, 'blacklistItems', 'black');
      }
      break;

    case 'left':
      delete players[d.nickname];
      addLog(`👋 ${d.nickname} — left the lobby`, 'info');
      break;

    case 'log':
      addLog(d.msg, 'info');
      break;

    case 'lobbyDetected':
      addLog(`🎯 Lobby: ${d.lobbyId}`, 'success');
      break;

    case 'update':
      if (players[d.nickname]) {
        players[d.nickname].cs2Value = d.cs2Value;
        if (d.inventory) {
          players[d.nickname].inventory = d.inventory;
          players[d.nickname].inventoryStatus = d.inventory.status;
        }
      }
      break;

    case 'inventoryStatus':
      if (d.status === 'private') {
        addLog(`🔒 Private inventory: ${d.steamId}`, 'warn');
      }
      if (d.nickname && players[d.nickname]) {
        players[d.nickname].inventoryStatus = d.status;
      }
      break;
  }

  renderPlayers();
});

// ============================================================
// KICK WARN
// ============================================================
let kickWarnTimer = null;
function showKickWarn(nick) {
  const el = $('kickWarn');
  $('kickWarnText').textContent = `⚠️ Open the FACEIT tab to kick: ${nick}`;
  el.classList.add('visible');
  clearTimeout(kickWarnTimer);
  kickWarnTimer = setTimeout(() => el.classList.remove('visible'), 8000);
}

// ============================================================
// START / STOP
// ============================================================
$('startBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'start', lobbyId: null });
  isRunning = true;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('statusDot').classList.add('active');
  players = {};
  addLog('🟢 Parser started', 'success');
  renderPlayers();
  updateTimer = setInterval(renderPlayers, 1000);
});

$('stopBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stop' });
  isRunning = false;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('statusDot').classList.remove('active');
  addLog('🔴 Parser stopped', 'warn');
  if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
});

// ============================================================
// FILTERS
// ============================================================
$('saveFilters').addEventListener('click', async () => {
  const filters = {
    minCs2Value: parseFloat($('minCs2').value) || 0,
    maxCs2Value: parseFloat($('maxCs2').value) || 999999,
    kickOnFail: $('kickOnFail').checked,
    kickIfNoData: $('kickIfNoData').checked,
  };
  window._filters = filters;
  await chrome.storage.local.set({ filters });
  await chrome.runtime.sendMessage({ action: 'reloadSettings' });
  addLog('💾 Filters saved', 'success');
  const btn = $('saveFilters');
  btn.textContent = '✅ Saved!';
  setTimeout(() => btn.textContent = '💾 Save Filters', 1500);
});

// Test inventory
$('testBtn').addEventListener('click', async () => {
  const steamInput = $('testSteamId').value.trim();
  if (!steamInput) return;
  const res = $('testResult');
  res.textContent = '⏳ Loading Buff prices and inventory...';
  res.style.color = '#f59e0b';

  const resp = await chrome.runtime.sendMessage({
    action: 'checkInventory',
    steamInput,
    steamId: steamInput,
  });
  if (resp?.value !== null && resp?.value !== undefined) {
    const idText = resp.steamId ? ` · ${resp.steamId}` : '';
    const inv = resp.inventory || {};
    const priced = inv.totalItems ? ` · ${inv.pricedItems || 0}/${inv.totalItems} priced` : '';
    const provider = inv.provider ? ` via ${inv.provider}` : '';
    res.textContent = `✅ CS2 inventory (Buff163${provider}): ${formatValue(resp.value)}${priced}${idText}`;
    res.style.color = '#4ade80';
  } else {
    const inv = resp?.inventory || {};
    const priced = inv.totalItems ? ` · ${inv.pricedItems || 0}/${inv.totalItems} priced` : '';
    res.textContent = `❌ ${resp?.error || 'unknown error'}${priced}`;
    res.style.color = '#f87171';
  }
});

// ============================================================
// LISTS
// ============================================================
function renderList(arr, containerId, type) {
  const el = $(containerId);
  if (!arr.length) { el.innerHTML = `<div style="color:#3a4a6a;font-size:11px;padding:4px 0">List is empty</div>`; return; }
  el.innerHTML = arr.map((nick, i) =>
    `<div class="list-tag ${type}">${nick}<span class="tag-remove" data-t="${type}" data-i="${i}">✕</span></div>`
  ).join('');
  el.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.i);
      if (btn.dataset.t === 'black') {
        blacklist.splice(idx, 1);
        await chrome.storage.local.set({ blacklist });
        renderList(blacklist, 'blacklistItems', 'black');
      } else {
        whitelist.splice(idx, 1);
        await chrome.storage.local.set({ whitelist });
        renderList(whitelist, 'whitelistItems', 'white');
      }
      await chrome.runtime.sendMessage({ action: 'reloadSettings' });
    });
  });
}

$('addBlack').addEventListener('click', async () => {
  const val = $('blacklistInput').value.trim().toLowerCase();
  if (!val || blacklist.includes(val)) return;
  blacklist.push(val);
  await chrome.storage.local.set({ blacklist });
  renderList(blacklist, 'blacklistItems', 'black');
  await chrome.runtime.sendMessage({ action: 'reloadSettings' });
  $('blacklistInput').value = '';
  addLog(`🚫 Blacklist: ${val}`, 'error');
});
$('blacklistInput').addEventListener('keydown', e => e.key === 'Enter' && $('addBlack').click());

$('addWhite').addEventListener('click', async () => {
  const val = $('whitelistInput').value.trim().toLowerCase();
  if (!val || whitelist.includes(val)) return;
  whitelist.push(val);
  await chrome.storage.local.set({ whitelist });
  renderList(whitelist, 'whitelistItems', 'white');
  await chrome.runtime.sendMessage({ action: 'reloadSettings' });
  $('whitelistInput').value = '';
  addLog(`⭐ Whitelist: ${val}`, 'success');
});
$('whitelistInput').addEventListener('keydown', e => e.key === 'Enter' && $('addWhite').click());

// ============================================================
// API KEY MANAGEMENT
// ============================================================

/** Generate a random key: 7EX-XXXX-XXXX-XXXX */
function generateKeyString() {
  const rand = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `7EX-${rand()}-${rand()}-${rand()}`;
}

/** Load keys array from storage */
async function loadKeys() {
  const data = await chrome.storage.local.get(['apiKeys']);
  return data.apiKeys || [];
}

/** Save keys array to storage */
async function saveKeys(keys) {
  await chrome.storage.local.set({ apiKeys: keys });
}

/** Render the keys list */
async function renderKeys() {
  const keys = await loadKeys();
  const container = $('keysList');

  if (!keys.length) {
    container.innerHTML = '<div class="keys-empty">No keys generated yet</div>';
    return;
  }

  const now = Date.now();
  container.innerHTML = keys.map((k, i) => {
    const isExpired = now > k.expiresAt;
    const expDate = new Date(k.expiresAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    const createdDate = new Date(k.createdAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    const daysLeft = Math.max(0, Math.ceil((k.expiresAt - now) / 86400000));

    return `<div class="key-card">
      <div class="key-card-top">
        <div class="key-code" title="${escHtml(k.key)}">${escHtml(k.key)}</div>
        <span class="key-copy-btn" data-key="${escHtml(k.key)}" title="Copy key">📋</span>
        <span class="key-revoke-btn" data-i="${i}" title="Revoke">✕</span>
      </div>
      <div class="key-meta">
        <span>Created: ${createdDate}</span>
        <span class="${isExpired ? 'expired' : 'active-badge'}">
          ${isExpired ? `⛔ Expired ${expDate}` : `✅ ${daysLeft}d left · expires ${expDate}`}
        </span>
        <span>${k.durationDays}d key</span>
      </div>
    </div>`;
  }).join('');

  // Copy button
  container.querySelectorAll('.key-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.key).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✅';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    });
  });

  // Revoke button
  container.querySelectorAll('.key-revoke-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.i);
      const keys = await loadKeys();
      const removed = keys.splice(idx, 1)[0];
      await saveKeys(keys);
      addLog(`🗑️ Key revoked: ${removed.key}`, 'warn');
      renderKeys();
    });
  });
}

/** Generate key button */
$('genKeyBtn').addEventListener('click', async () => {
  const days = parseInt($('keyDuration').value);
  const keyStr = generateKeyString();
  const now = Date.now();

  const newKey = {
    key: keyStr,
    durationDays: days,
    createdAt: now,
    expiresAt: now + days * 86400000,
  };

  const keys = await loadKeys();
  keys.push(newKey);
  await saveKeys(keys);

  // Show the newly created key once
  const resultBox = $('newKeyResult');
  $('newKeyCode').textContent = keyStr;
  resultBox.style.display = 'block';

  // Copy-once button
  $('newKeyCopy').onclick = () => {
    navigator.clipboard.writeText(keyStr).then(() => {
      $('newKeyCopy').textContent = '✅';
      setTimeout(() => $('newKeyCopy').textContent = '📋', 1500);
    });
  };

  addLog(`🔑 Key generated (${days}d): ${keyStr}`, 'success');
  renderKeys();
});

// ============================================================
// LOAD SAVED
// ============================================================
async function loadAll() {
  const data = await chrome.storage.local.get(['blacklist','whitelist','filters']);

  blacklist = data.blacklist || [];
  whitelist = data.whitelist || [];
  renderList(blacklist, 'blacklistItems', 'black');
  renderList(whitelist, 'whitelistItems', 'white');

  if (data.filters) {
    window._filters = data.filters;
    if (data.filters.minCs2Value !== undefined) $('minCs2').value = data.filters.minCs2Value;
    if (data.filters.maxCs2Value !== undefined && data.filters.maxCs2Value < 999999) $('maxCs2').value = data.filters.maxCs2Value;
    if (data.filters.kickOnFail !== undefined) $('kickOnFail').checked = data.filters.kickOnFail;
    if (data.filters.kickIfNoData !== undefined) $('kickIfNoData').checked = data.filters.kickIfNoData;
  }

  const state = await chrome.runtime.sendMessage({ action: 'getState' });
  if (state?.isRunning) {
    isRunning = true;
    $('startBtn').disabled = true;
    $('stopBtn').disabled = false;
    $('statusDot').classList.add('active');
    players = state.players || {};
    renderPlayers();
    updateTimer = setInterval(renderPlayers, 1000);
  }
}

loadAll();
