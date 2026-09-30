// ============================================================
// FaceIT Parser - Content Script v5.1
// Robust lobby DOM scanner + manual-like DOM kick
// ============================================================

(function () {
  'use strict';

  if (window.__faceitParserContentLoaded) return;
  window.__faceitParserContentLoaded = true;

  const KICK_WORDS = [
    'kick', 'remove', 'exclude',
    'кик', 'кік', 'виключ', 'видал', 'удал', 'исключ',
    'вигнати', 'вигнать', 'выгнать', 'ізгнати', 'изгнать', 'изгон',
  ];
  const CANCEL_WORDS = [
    'cancel', 'close', 'no', 'back',
    'скас', 'отмен', 'ні', 'нет',
  ];
  const CONFIRM_WORDS = [
    'confirm', 'yes', 'kick', 'remove', 'ok',
    'підтверд', 'подтверд', 'підтвердити', 'підтвердить', 'подтвердить', 'подтвердити',
    'так', 'да', 'видал', 'виключ', 'кик', 'кік', 'выгнать', 'вигнати',
  ];
  const EDIT_WORDS = [
    'edit', 'settings', 'configure', 'change group', 'party settings',
    'редакт', 'измен', 'настрой', 'налаш', 'групп', 'груп',
  ];
  const EDIT_DIALOG_WORDS = [
    'edit your group', 'edit group', 'party settings',
    'отредактируйте свою группу', 'редактировать группу', 'изменить группу',
    'участники группы', 'название группы', 'режим игры',
  ];
  // Dialogs to never auto-confirm (audio/voice setup, etc.)
  const IGNORED_DIALOG_WORDS = [
    'microphone', 'speaker', 'voice', 'audio', 'voicechat', 'voice chat',
    'мікрофон', 'микрофон', 'динамік', 'динамик', 'голос', 'звук',
    'приготовьтесь к разговору', 'готуйтесь до розмови',
    'присоединиться к войсчату', 'приєднатись до голосового',
    'voice activation', 'push to talk', 'требуется разрешение',
  ];
  const IGNORED_NICK_WORDS = new Set([
    'faceit', 'players', 'player', 'members', 'member', 'party', 'lobby',
    'room', 'team', 'captain', 'ready', 'join', 'invite', 'kick', 'remove',
    'settings', 'friends', 'online', 'offline', 'premium', 'verified',
    'level', 'elo', 'match', 'matches', 'overview', 'stats', 'shop',
  ]);

  // ============================================================
  // SAFE EXTENSION MESSAGE
  // ============================================================

  function sendRuntimeMessage(message, callback) {
    try {
      const maybePromise = chrome.runtime.sendMessage(message, callback);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {}
  }

  function log(msg) {
    console.log(`[FaceIT Parser] ${msg}`);
    sendRuntimeMessage({ action: 'contentLog', msg });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  // SOUND
  // ============================================================

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function withAudioCtx(callback) {
    try {
      const ctx = getAudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => callback(ctx)).catch(() => {});
      } else {
        callback(ctx);
      }
    } catch (_) {}
  }

  function primeAudio() {
    try { getAudioCtx(); } catch (_) {}
  }

  window.addEventListener('pointerdown', primeAudio, { once: true, capture: true });
  window.addEventListener('keydown', primeAudio, { once: true, capture: true });

  function playPassSound() {
    // Realistic German Shepherd bark — same volume level as kick sound (master gain 0.4)
    withAudioCtx(ctx => {
      const start = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.4, start); // same loudness as playKickSound
      master.connect(ctx.destination);

      const bark = (at) => {
        const t = start + at;

        // ── Tonal body: deep chest oscillator ──
        const osc = ctx.createOscillator();
        const oscFilter = ctx.createBiquadFilter();
        const oscGain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, t);
        osc.frequency.exponentialRampToValueAtTime(80, t + 0.18);
        oscFilter.type = 'bandpass';
        oscFilter.frequency.setValueAtTime(500, t);
        oscFilter.Q.setValueAtTime(1.5, t);
        oscGain.gain.setValueAtTime(0.001, t);
        oscGain.gain.exponentialRampToValueAtTime(0.55, t + 0.012);
        oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc.connect(oscFilter);
        oscFilter.connect(oscGain);
        oscGain.connect(master);
        osc.start(t);
        osc.stop(t + 0.25);

        // ── Growl sub layer ──
        const sub = ctx.createOscillator();
        const subGain = ctx.createGain();
        sub.type = 'square';
        sub.frequency.setValueAtTime(90, t);
        sub.frequency.exponentialRampToValueAtTime(50, t + 0.20);
        subGain.gain.setValueAtTime(0.001, t);
        subGain.gain.exponentialRampToValueAtTime(0.30, t + 0.015);
        subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
        sub.connect(subGain);
        subGain.connect(master);
        sub.start(t);
        sub.stop(t + 0.22);

        // ── Noise burst: attack transient (breath/consonant) ──
        const burstDur = 0.06;
        const burstBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * burstDur), ctx.sampleRate);
        const burstData = burstBuf.getChannelData(0);
        for (let i = 0; i < burstData.length; i++) burstData[i] = (Math.random() * 2 - 1);
        const burst = ctx.createBufferSource();
        const burstFilter = ctx.createBiquadFilter();
        const burstGain = ctx.createGain();
        burst.buffer = burstBuf;
        burstFilter.type = 'bandpass';
        burstFilter.frequency.setValueAtTime(1200, t);
        burstFilter.Q.setValueAtTime(0.8, t);
        burstGain.gain.setValueAtTime(0.55, t);
        burstGain.gain.exponentialRampToValueAtTime(0.001, t + burstDur);
        burst.connect(burstFilter);
        burstFilter.connect(burstGain);
        burstGain.connect(master);
        burst.start(t);
        burst.stop(t + burstDur);

        // ── Noise tail: resonant bark body ──
        const tailDur = 0.20;
        const tailBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * tailDur), ctx.sampleRate);
        const tailData = tailBuf.getChannelData(0);
        for (let i = 0; i < tailData.length; i++) tailData[i] = (Math.random() * 2 - 1) * 0.6;
        const tail = ctx.createBufferSource();
        const tailFilter = ctx.createBiquadFilter();
        const tailGain = ctx.createGain();
        tail.buffer = tailBuf;
        tailFilter.type = 'bandpass';
        tailFilter.frequency.setValueAtTime(700, t);
        tailFilter.Q.setValueAtTime(3.5, t);
        tailGain.gain.setValueAtTime(0.001, t);
        tailGain.gain.exponentialRampToValueAtTime(0.40, t + 0.018);
        tailGain.gain.exponentialRampToValueAtTime(0.001, t + tailDur);
        tail.connect(tailFilter);
        tailFilter.connect(tailGain);
        tailGain.connect(master);
        tail.start(t);
        tail.stop(t + tailDur);
      };

      // Two barks — classic GSD double-bark pattern
      bark(0.00);
      bark(0.32);
    });
  }

  function playSuccessSound() {
    withAudioCtx(ctx => {
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.09);
        gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + i * 0.09 + 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.09 + 0.55);
        osc.start(ctx.currentTime + i * 0.09);
        osc.stop(ctx.currentTime + i * 0.09 + 0.6);
      });
    });
  }

  function playKickSound() {
    withAudioCtx(ctx => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    });
  }

  // ============================================================
  // TOOLTIP STYLES
  // ============================================================

  function injectStyles() {
    if (document.getElementById('fp-styles')) return;
    const style = document.createElement('style');
    style.id = 'fp-styles';
    style.textContent = `
      #fp-tooltip {
        position: fixed;
        z-index: 999999;
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px) scale(0.97);
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      #fp-tooltip.visible {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }
      .fp-card {
        background: #0d1117;
        border: 1px solid #1e2530;
        border-radius: 8px;
        width: 260px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,85,0,0.15);
        font-family: 'Rajdhani', 'Segoe UI', sans-serif;
        overflow: hidden;
      }
      .fp-card-header {
        background: linear-gradient(135deg, #13181f, #1a0e00);
        border-bottom: 1px solid #1e2530;
        padding: 10px 12px 8px;
        position: relative;
      }
      .fp-card-header::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, #ff5500, #ff8c42, transparent);
      }
      .fp-nickname {
        font-size: 15px;
        font-weight: 700;
        color: #fff;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fp-status-badge {
        display: inline-block;
        margin-top: 4px;
        padding: 2px 8px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .fp-status-badge.passed { background: rgba(0,230,118,0.15); color: #00e676; border: 1px solid rgba(0,230,118,0.3); }
      .fp-status-badge.kicked { background: rgba(255,23,68,0.15); color: #ff1744; border: 1px solid rgba(255,23,68,0.3); }
      .fp-status-badge.checking { background: rgba(255,214,0,0.15); color: #ffd600; border: 1px solid rgba(255,214,0,0.3); }
      .fp-status-badge.white { background: rgba(0,176,255,0.15); color: #00b0ff; border: 1px solid rgba(0,176,255,0.3); }
      .fp-status-badge.nodata { background: rgba(255,214,0,0.12); color: #ffd600; border: 1px solid rgba(255,214,0,0.28); }
      .fp-status-badge.unknown { background: rgba(107,122,141,0.15); color: #6b7a8d; border: 1px solid rgba(107,122,141,0.3); }
      .fp-body { padding: 10px 12px; }
      .fp-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 0;
        border-bottom: 1px solid #151a22;
      }
      .fp-row:last-child { border-bottom: none; }
      .fp-row-label {
        font-size: 11px;
        color: #6b7a8d;
        text-transform: uppercase;
        font-weight: 600;
      }
      .fp-row-value {
        font-size: 13px;
        font-weight: 700;
        font-family: 'Share Tech Mono', 'Courier New', monospace;
        color: #c8d0dc;
      }
      .fp-row-value.green { color: #00e676; }
      .fp-row-value.red { color: #ff1744; }
      .fp-row-value.yellow { color: #ffd600; }
      .fp-row-value.blue { color: #00b0ff; }
      .fp-filter-bar {
        padding: 6px 12px 8px;
        background: #0f1218;
        border-top: 1px solid #1e2530;
      }
      .fp-filter-title {
        font-size: 9px;
        color: #ff5500;
        text-transform: uppercase;
        font-weight: 700;
        margin-bottom: 5px;
      }
      .fp-filter-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
        font-size: 11px;
      }
      .fp-filter-text { color: #8a96a3; flex: 1; }
      .fp-filter-result { font-weight: 700; font-size: 11px; font-family: 'Share Tech Mono', monospace; }
      .fp-filter-result.ok { color: #00e676; }
      .fp-filter-result.fail { color: #ff1744; }
      .fp-filter-result.na { color: #6b7a8d; }
      .fp-footer {
        padding: 6px 12px 8px;
        display: flex;
        gap: 6px;
      }
      .fp-btn {
        flex: 1;
        padding: 5px 0;
        border-radius: 4px;
        font-family: 'Rajdhani', sans-serif;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        cursor: pointer;
        pointer-events: auto;
      }
      .fp-btn-kick { background: rgba(255,23,68,0.15); color: #ff1744; border: 1px solid rgba(255,23,68,0.3); }
      .fp-btn-wl { background: rgba(0,176,255,0.1); color: #00b0ff; border: 1px solid rgba(0,176,255,0.3); }
      .fp-btn-bl { background: rgba(255,23,68,0.08); color: #ff6b6b; border: 1px solid rgba(255,23,68,0.2); }
      .fp-loading {
        display: flex;
        align-items: center;
        gap: 6px;
        color: #ffd600;
        font-size: 11px;
        padding: 4px 0;
      }
      .fp-spinner {
        width: 10px;
        height: 10px;
        border: 2px solid rgba(255,214,0,0.2);
        border-top-color: #ffd600;
        border-radius: 50%;
        animation: fp-spin 0.7s linear infinite;
      }
      @keyframes fp-spin { to { transform: rotate(360deg); } }
      [data-fp-injected] { cursor: pointer; }
    `;
    document.head.appendChild(style);
  }

  // ============================================================
  // PLAYER DISCOVERY
  // ============================================================

  function cleanNickname(value) {
    const text = String(value || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^@/, '');

    if (!text || text.length > 80) return null;

    const candidates = [text, ...text.split(' ')];
    for (const raw of candidates) {
      const nick = raw
        .replace(/[()[\]{}]/g, '')
        .replace(/[,:;|]/g, '')
        .trim();
      if (!nick || nick.length < 2 || nick.length > 32) continue;
      if (IGNORED_NICK_WORDS.has(nick.toLowerCase())) continue;
      if (/^[\p{L}\p{N}_.-]{2,32}$/u.test(nick)) return nick;
    }

    return null;
  }

  function nicknameFromHref(href) {
    const match = String(href || '').match(/\/players(?:-modal)?\/([^/?#]+)/i);
    if (!match) return null;
    try {
      return cleanNickname(decodeURIComponent(match[1]));
    } catch (_) {
      return cleanNickname(match[1]);
    }
  }

  function elementSignature(el) {
    if (!el) return '';
    return [
      el.tagName,
      el.id,
      typeof el.className === 'string' ? el.className : '',
      el.getAttribute?.('data-testid') || '',
      el.getAttribute?.('role') || '',
      el.getAttribute?.('aria-label') || '',
    ].join(' ').toLowerCase();
  }

  function isIgnoredArea(el) {
    try {
      return !!el.closest('header, nav, [role="navigation"], [data-testid*="header" i], [data-testid*="nav" i], [class*="header" i], [class*="sidebar" i]');
    } catch (_) {
      return false;
    }
  }

  function countProfileLinks(el) {
    try {
      return el?.querySelectorAll?.('a[href*="/players/"], a[href*="/players-modal/"]').length || 0;
    } catch (_) {
      return 0;
    }
  }

  function normalizeNickForCompare(value) {
    return String(cleanNickname(value) || value || '')
      .trim()
      .toLowerCase()
      .replace(/0/g, 'o');
  }

  function sameNickname(a, b) {
    const ca = cleanNickname(a);
    const cb = cleanNickname(b);
    if (!ca || !cb) return false;
    return ca.toLowerCase() === cb.toLowerCase()
      || normalizeNickForCompare(ca) === normalizeNickForCompare(cb);
  }

  function findPlayerRoot(el) {
    let current = el;
    let best = el;

    for (let i = 0; i < 8 && current?.parentElement && current.parentElement !== document.body; i++) {
      current = current.parentElement;
      if (isIgnoredArea(current)) break;

      const profileLinks = countProfileLinks(current);
      if (profileLinks > 2) break;

      const sig = elementSignature(current);
      if (/(member|player|slot|lineup|roster|card|user|participant)/i.test(sig) || profileLinks === 1) {
        best = current;
      }
      if (findKickBtn(current)) return current;
    }

    return best;
  }

  function hasLobbyContext(el, root) {
    if (isIgnoredArea(el) || isIgnoredArea(root)) return false;

    let current = root || el;
    for (let i = 0; i < 7 && current; i++) {
      const sig = elementSignature(current);
      if (/(member|player|party|lobby|room|team|slot|lineup|roster|captain)/i.test(sig)) return true;
      current = current.parentElement;
    }

    if (/(\/room\/|\/lobby\/|\/matchmaking\/|\/party\/)/i.test(location.pathname)) return true;
    return false;
  }

  function collectPlayerCandidates() {
    const found = new Map();

    function addCandidate(nickname, el, source) {
      const nick = cleanNickname(nickname);
      if (!nick || !el || el.closest?.('#fp-tooltip')) return;

      const root = findPlayerRoot(el);
      if (!hasLobbyContext(el, root)) return;

      const lower = nick.toLowerCase();
      const current = found.get(lower);
      const candidate = {
        nickname: nick,
        el,
        root,
        source,
        hasKickButton: !!findKickBtn(root),
      };

      if (!current || (candidate.hasKickButton && !current.hasKickButton)) {
        found.set(lower, candidate);
      }
    }

    document.querySelectorAll('a[href*="/players/"], a[href*="/players-modal/"]').forEach(el => {
      addCandidate(nicknameFromHref(el.getAttribute('href')), el, 'profile-link');
    });

    const nickSelectors = [
      '[data-testid*="nickname" i]',
      '[data-testid*="username" i]',
      '[data-testid*="player-name" i]',
      '[class*="nickname" i]',
      '[class*="username" i]',
      '[class*="userName" i]',
      '[class*="PlayerName" i]',
    ];

    for (const selector of nickSelectors) {
      try {
        document.querySelectorAll(selector).forEach(el => {
          const text = el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent;
          addCandidate(text, el, 'text-selector');
        });
      } catch (_) {}
    }

    const containerSelectors = [
      '[data-testid*="member" i]',
      '[data-testid*="player" i]',
      '[class*="Member" i]',
      '[class*="member" i]',
      '[class*="Player" i]',
      '[class*="player" i]',
      '[class*="Party" i]',
      '[class*="party" i]',
      '[class*="Lobby" i]',
      '[class*="lobby" i]',
    ];

    for (const selector of containerSelectors) {
      try {
        document.querySelectorAll(selector).forEach(root => {
          if (isIgnoredArea(root)) return;
          const link = root.querySelector?.('a[href*="/players/"], a[href*="/players-modal/"]');
          if (link) {
            addCandidate(nicknameFromHref(link.getAttribute('href')), link, 'container-link');
            return;
          }

          const nickEl = root.querySelector?.('[data-testid*="nickname" i], [data-testid*="username" i], [class*="nickname" i], [class*="username" i], [class*="userName" i]');
          if (nickEl) {
            addCandidate(nickEl.getAttribute('title') || nickEl.textContent, nickEl, 'container-text');
          }
        });
      } catch (_) {}
    }

    return [...found.values()].sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  function getPlayersFromDOM() {
    return collectPlayerCandidates().map(player => ({
      nickname: player.nickname,
      hasKickButton: player.hasKickButton,
      source: player.source,
    }));
  }

  let reportTimer = null;
  let lastPlayersSignature = '';

  function reportPlayersIfChanged(delay = 250) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const players = getPlayersFromDOM();
      const signature = players.map(p => p.nickname.toLowerCase()).sort().join('|');
      if (signature === lastPlayersSignature) return;
      lastPlayersSignature = signature;
      sendRuntimeMessage({ action: 'domPlayers', players });
    }, delay);
  }

  // ============================================================
  // TOOLTIP
  // ============================================================

  let tooltip = null;
  let hideTimer = null;
  let currentNick = null;

  function createTooltip() {
    if (tooltip) return;
    tooltip = document.createElement('div');
    tooltip.id = 'fp-tooltip';
    tooltip.innerHTML = '<div class="fp-card"></div>';
    document.body.appendChild(tooltip);
    tooltip.addEventListener('mouseleave', () => scheduleHide());
    tooltip.addEventListener('mouseenter', () => cancelHide());
  }

  function positionTooltip(x, y) {
    const width = 264;
    const height = 300;
    let left = x + 12;
    let top = y - 10;

    if (left + width > window.innerWidth - 10) left = x - width - 8;
    if (top + height > window.innerHeight - 10) top = window.innerHeight - height - 10;
    if (top < 10) top = 10;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showTooltip(nickname, x, y) {
    cancelHide();
    createTooltip();
    currentNick = nickname;
    positionTooltip(x, y);
    renderTooltip(nickname);
    tooltip.classList.add('visible');
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove('visible');
    currentNick = null;
  }

  function scheduleHide(delay = 300) {
    hideTimer = setTimeout(hideTooltip, delay);
  }

  function cancelHide() {
    clearTimeout(hideTimer);
  }

  function renderTooltip(nickname) {
    const card = tooltip.querySelector('.fp-card');

    sendRuntimeMessage({ action: 'getPlayerData', nickname }, data => {
      if (currentNick !== nickname) return;

      const p = data?.player || {};
      const filters = data?.filters || {};

      let statusClass = 'unknown';
      let statusText = 'Unknown';
      if (p.passed) { statusClass = 'passed'; statusText = 'Passed'; }
      if (p.whitelisted) { statusClass = 'white'; statusText = 'Whitelist'; }
      if (p.kicked) { statusClass = 'kicked'; statusText = 'Kicked'; }
      if (p.noData) { statusClass = 'nodata'; statusText = 'No data'; }
      if (p.checking) { statusClass = 'checking'; statusText = 'Checking'; }

      const timeInLobby = p.joinTime
        ? formatTime(Math.floor((Date.now() - p.joinTime) / 1000))
        : '-';

      const cs2Value = p.cs2Value !== null && p.cs2Value !== undefined
        ? `$${parseFloat(p.cs2Value).toFixed(2)}`
        : null;
      const inv = p.inventory || {};
      const invSource = `${inv.source || p.inventorySource || 'Buff163'}${inv.provider ? '@' + inv.provider : ''}`;
      const invStatus = p.checking
        ? 'Checking'
        : ({
          ok: 'Buff price ready',
          partial: 'Partial Buff price',
          empty: 'Empty inventory',
          private: 'Private inventory',
          rate_limited: 'Steam rate limit',
          price_data_unavailable: 'No Buff data',
          pricing_unavailable: 'Pricing source down',
          no_priced_items: 'No Buff price match',
          no_steam_id: 'No Steam ID',
          invalid_steam_id: 'Bad Steam ID',
          steam_error: 'Steam error',
          inventory_unavailable: 'Inventory unavailable',
          no_data: 'No data',
        }[inv.status || p.inventoryStatus] || 'No data');
      const pricedText = inv.totalItems
        ? `${invSource} ${inv.pricedItems || 0}/${inv.totalItems}`
        : invStatus;

      let cs2FilterClass = 'na';
      let cs2FilterText = '-';
      if (cs2Value !== null && filters.minCs2Value !== undefined) {
        const value = parseFloat(p.cs2Value);
        const min = filters.minCs2Value || 0;
        const max = filters.maxCs2Value || 999999;
        const ok = value >= min && value <= max;
        cs2FilterClass = ok ? 'ok' : 'fail';
        cs2FilterText = `$${min} - $${max}`;
      }

      card.innerHTML = `
        <div class="fp-card-header">
          <div class="fp-nickname">${escHtml(nickname)}</div>
          <div class="fp-status-badge ${statusClass}">${statusText}</div>
        </div>
        <div class="fp-body">
          <div class="fp-row">
            <span class="fp-row-label">Time in lobby</span>
            <span class="fp-row-value blue">${timeInLobby}</span>
          </div>
          <div class="fp-row">
            <span class="fp-row-label">CS2 Inventory</span>
            <span class="fp-row-value ${cs2Value ? (cs2FilterClass === 'ok' ? 'green' : cs2FilterClass === 'fail' ? 'red' : '') : 'yellow'}">
              ${p.checking && cs2Value === null
                ? '<span class="fp-loading"><span class="fp-spinner"></span>Loading...</span>'
                : (cs2Value || escHtml(invStatus))}
            </span>
          </div>
          <div class="fp-row">
            <span class="fp-row-label">Buff163 match</span>
            <span class="fp-row-value blue">${escHtml(pricedText)}</span>
          </div>
          <div class="fp-row">
            <span class="fp-row-label">Steam ID</span>
            <span class="fp-row-value" style="font-size:10px;color:#6b7a8d">${p.steamId ? `${p.steamId.slice(-8)}...` : '-'}</span>
          </div>
        </div>
        <div class="fp-filter-bar">
          <div class="fp-filter-title">Filter Results</div>
          <div class="fp-filter-row">
            <span class="fp-filter-text">CS2 value (Buff)</span>
            <span class="fp-filter-result ${cs2FilterClass}">${cs2FilterClass === 'ok' ? 'OK' : cs2FilterClass === 'fail' ? 'FAIL' : 'N/A'}</span>
          </div>
          <div class="fp-filter-row">
            <span class="fp-filter-text">Filter range</span>
            <span class="fp-filter-result na">${cs2FilterText}</span>
          </div>
        </div>
        <div class="fp-footer">
          <button class="fp-btn fp-btn-kick" data-nick="${escHtml(nickname)}">Kick</button>
          <button class="fp-btn fp-btn-wl" data-nick="${escHtml(nickname)}">Whitelist</button>
          <button class="fp-btn fp-btn-bl" data-nick="${escHtml(nickname)}">Blacklist</button>
        </div>
      `;

      card.querySelector('.fp-btn-kick')?.addEventListener('click', e => {
        e.stopPropagation();
        kickPlayerByNickname(e.currentTarget.dataset.nick);
        hideTooltip();
      });
      card.querySelector('.fp-btn-wl')?.addEventListener('click', e => {
        e.stopPropagation();
        sendRuntimeMessage({ action: 'addToList', list: 'whitelist', nickname: e.currentTarget.dataset.nick });
        hideTooltip();
      });
      card.querySelector('.fp-btn-bl')?.addEventListener('click', e => {
        e.stopPropagation();
        sendRuntimeMessage({ action: 'addToList', list: 'blacklist', nickname: e.currentTarget.dataset.nick });
        hideTooltip();
      });
    });

    if (!card.innerHTML.includes('fp-card-header')) {
      card.innerHTML = `
        <div class="fp-card-header">
          <div class="fp-nickname">${escHtml(nickname)}</div>
          <div class="fp-status-badge checking">Loading...</div>
        </div>
        <div class="fp-body">
          <div class="fp-loading" style="padding:12px 0"><span class="fp-spinner"></span>Fetching player data...</div>
        </div>`;
    }
  }

  function injectHoverOnPlayers() {
    for (const player of collectPlayerCandidates()) {
      const el = player.el;
      if (!el || el.dataset.fpInjected) continue;
      el.dataset.fpInjected = '1';

      el.addEventListener('mouseenter', event => {
        cancelHide();
        showTooltip(player.nickname, event.clientX, event.clientY);
      });
      el.addEventListener('mousemove', event => {
        if (currentNick === player.nickname) positionTooltip(event.clientX, event.clientY);
      });
      el.addEventListener('mouseleave', () => scheduleHide(200));
    }
  }

  function formatTime(seconds) {
    if (!seconds) return '0s';
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  }

  function escHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  // MANUAL-LIKE DOM KICK
  // ============================================================

  function textOf(el) {
    return [
      el?.textContent || '',
      el?.getAttribute?.('aria-label') || '',
      el?.getAttribute?.('title') || '',
      el?.getAttribute?.('data-testid') || '',
    ].join(' ').toLowerCase();
  }

  function containsAny(text, words) {
    return words.some(word => text.includes(word));
  }

  function isEditOrSettingsElement(el) {
    return containsAny(textOf(el), EDIT_WORDS);
  }

  function isEditGroupDialog(el) {
    const text = textOf(el);
    return containsAny(text, EDIT_DIALOG_WORDS);
  }

  function isIgnoredDialog(el) {
    const text = textOf(el).toLowerCase();
    return IGNORED_DIALOG_WORDS.some(w => text.includes(w));
  }

  function findEditGroupDialog() {
    return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [data-testid*="modal" i]')]
      .find(isEditGroupDialog) || null;
  }

  function isUnsafeKickTarget(el, scope = null) {
    if (!el || el.closest?.('#fp-tooltip')) return true;
    if (scope && !scope.contains(el)) return true;
    if (isEditOrSettingsElement(el)) return true;
    const dialog = el.closest?.('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]');
    if (dialog && isEditGroupDialog(dialog) && !containsAny(textOf(el), KICK_WORDS)) return true;
    return false;
  }

  function isKickElement(el) {
    if (isUnsafeKickTarget(el)) return false;
    const text = textOf(el);
    return containsAny(text, KICK_WORDS) && !containsAny(text, EDIT_WORDS);
  }

  function findKickBtn(container) {
    if (!container?.querySelectorAll) return null;

    const selectors = [
      '[data-testid*="kick" i]',
      '[data-testid*="remove" i]',
      '[aria-label*="kick" i]',
      '[aria-label*="remove" i]',
      'button[class*="kick" i]',
      'button[class*="remove" i]',
      '[role="menuitem"][class*="kick" i]',
      '[role="menuitem"][class*="remove" i]',
    ];

    for (const selector of selectors) {
      try {
        const match = [...container.querySelectorAll(selector)].find(el => !isUnsafeKickTarget(el, container));
        if (match) return match;
      } catch (_) {}
    }

    const clickables = container.querySelectorAll('button, [role="button"], [role="menuitem"], a');
    for (const el of clickables) {
      if (isKickElement(el)) return el;
    }

    return null;
  }

  function findOpenMenuKickBtn() {
    const roots = [
      ...document.querySelectorAll('[role="menu"], [class*="menu" i], [class*="dropdown" i], [class*="popover" i], [data-testid*="menu" i]'),
    ].filter(root => !isEditGroupDialog(root));

    for (const root of roots) {
      const btn = findKickBtn(root);
      if (btn) return btn;
    }

    return null;
  }

  function isMenuOpener(el) {
    if (!el || el.closest?.('#fp-tooltip')) return false;
    const text = textOf(el);
    if (containsAny(text, EDIT_WORDS)) return false;
    if (/(more|menu|option|action|overflow|ellipsis)/i.test(text)) return true;
    if (text.includes('...')) return true;
    if (el.getAttribute?.('aria-haspopup') === 'menu') return true;
    if (el.querySelector?.('svg') && (el.textContent || '').trim().length <= 3) return true;
    return false;
  }

  async function clickLikeUser(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    } catch (_) {}

    await sleep(80);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    };

    for (const type of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(new MouseEvent(type, eventInit));
      } catch (_) {}
    }

    try {
      el.click();
    } catch (_) {}

    return true;
  }

  async function confirmKickIfNeeded() {
    // Retry up to 10 times (up to ~2s) waiting for the confirm dialog to appear
    const maxAttempts = 10;
    const attemptDelay = 200;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(attempt === 0 ? 300 : attemptDelay);

      const dialogs = [
        ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [data-testid*="modal" i], [class*="overlay" i], [class*="popup" i]'),
      ].filter(dialog => !isEditGroupDialog(dialog) && !isIgnoredDialog(dialog));

      for (const dialog of dialogs) {
        // Skip hidden dialogs
        const style = window.getComputedStyle(dialog);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        // Only act on dialogs that are about kicking (contain kick-related words)
        const dialogText = textOf(dialog);
        if (!containsAny(dialogText, KICK_WORDS) && !containsAny(dialogText, CONFIRM_WORDS)) continue;

        const buttons = [...dialog.querySelectorAll('button, [role="button"], [class*="button" i]')]
          .filter(btn => {
            const t = textOf(btn).trim();
            if (!t) return false;
            if (containsAny(t, CANCEL_WORDS)) return false;
            if (isEditOrSettingsElement(btn)) return false;
            return true;
          });

        // Prefer explicit confirm word match, fall back to last visible button
        const confirm = buttons.find(btn => containsAny(textOf(btn), CONFIRM_WORDS))
          || buttons.find(btn => {
            const rect = btn.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });

        if (confirm) {
          log(`Confirm dialog found on attempt ${attempt + 1}, clicking: "${textOf(confirm).trim()}"`);
          await clickLikeUser(confirm);
          await sleep(300);
          return true;
        }
      }
    }

    log('Confirm dialog not found after retries');
    return false;
  }

  async function closeDialog(dialog) {
    if (!dialog) return false;
    const closeBtn = [...dialog.querySelectorAll('button, [role="button"]')]
      .find(btn => containsAny(textOf(btn), CANCEL_WORDS) || /close|dismiss|x/i.test(textOf(btn)));
    if (closeBtn) {
      await clickLikeUser(closeBtn);
      await sleep(150);
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    return true;
  }

  async function doKick(btn, nickname) {
    if (isUnsafeKickTarget(btn)) return false;
    await clickLikeUser(btn);
    await confirmKickIfNeeded();
    log(`Kick click sent for: ${nickname}`);
    return true;
  }

  function findPlayerCandidate(nickname) {
    const target = cleanNickname(nickname);
    if (!target) return null;
    return collectPlayerCandidates().find(player => sameNickname(player.nickname, target)) || null;
  }

  async function openMenusAndKick(root, nickname) {
    const buttons = [...root.querySelectorAll('button, [role="button"], [aria-haspopup="menu"]')]
      .filter(btn => root.contains(btn) && isMenuOpener(btn));

    for (const button of buttons) {
      await clickLikeUser(button);
      await sleep(350);

      const kickBtn = findOpenMenuKickBtn();
      if (kickBtn) return doKick(kickBtn, nickname);

      const editDialog = findEditGroupDialog();
      if (editDialog) {
        log(`Avoided group edit dialog while kicking: ${nickname}`);
        await closeDialog(editDialog);
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(100);
    }

    return false;
  }

  async function kickViaContextMenu(player, nickname) {
    const el = player.el || player.root;
    if (!el) return false;

    const rect = el.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 2,
    };

    try {
      el.dispatchEvent(new MouseEvent('contextmenu', eventInit));
    } catch (_) {}

    await sleep(350);
    const kickBtn = findOpenMenuKickBtn();
    const editDialog = findEditGroupDialog();
    if (editDialog) {
      log(`Avoided group edit dialog after context menu: ${nickname}`);
      await closeDialog(editDialog);
    }
    return kickBtn ? doKick(kickBtn, nickname) : false;
  }

  async function kickPlayerByNickname(nickname) {
    const player = findPlayerCandidate(nickname);
    if (!player) {
      log(`Player row not found for kick: ${nickname}`);
      return false;
    }

    log(`DOM kick search: ${nickname}`);

    const alreadyOpenEditDialog = findEditGroupDialog();
    if (alreadyOpenEditDialog) await closeDialog(alreadyOpenEditDialog);

    const root = player.root || findPlayerRoot(player.el);
    const directBtn = findKickBtn(root);
    if (directBtn && await doKick(directBtn, nickname)) return true;

    if (await openMenusAndKick(root, nickname)) return true;
    if (await kickViaContextMenu(player, nickname)) return true;

    log(`Kick button not found for: ${nickname}`);
    return false;
  }

  // ============================================================
  // LOBBY DETECT
  // ============================================================

  function extractLobbyInfo() {
    const url = window.location.href;
    const match = url.match(/\/(?:room|hub|lobby)\/([a-f0-9-]{20,36})/i);
    return {
      lobbyId: match?.[1] || null,
      url,
      isLobbyPage: !!match || /(\/room\/|\/lobby\/|\/matchmaking\/|\/party\/)/i.test(location.pathname),
      players: getPlayersFromDOM(),
    };
  }

  function reportCurrentPage() {
    sendRuntimeMessage({ action: 'pageInfo', ...extractLobbyInfo() });
  }

  // ============================================================
  // MESSAGE LISTENER
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'playSound') {
      if (msg.type === 'kick') playKickSound();
      else if (msg.type === 'pass') playPassSound();
      else playSuccessSound();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'getLobbyInfo') {
      sendResponse(extractLobbyInfo());
      return true;
    }

    if (msg.action === 'kickPlayer') {
      kickPlayerByNickname(msg.nickname).then(ok => sendResponse({ ok }));
      return true;
    }

    if (msg.action === 'getPlayersFromDOM') {
      sendResponse({ players: getPlayersFromDOM() });
      return true;
    }
  });

  // ============================================================
  // INIT
  // ============================================================

  injectStyles();
  createTooltip();

  const observer = new MutationObserver(() => {
    injectHoverOnPlayers();
    reportPlayersIfChanged();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => {
        injectHoverOnPlayers();
        reportCurrentPage();
        reportPlayersIfChanged(50);
      }, 800);
    }
  });
  urlObserver.observe(document, { subtree: true, childList: true });

  injectHoverOnPlayers();
  reportCurrentPage();
  reportPlayersIfChanged(50);
  log('Content script v5.1 loaded');
})();
