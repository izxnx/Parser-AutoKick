// ============================================================
// FaceIT Parser - Background Service Worker v6.0
// CS2 inventory: steamcommunity.com/inventory + CSGOTrader Buff prices (used for filters/auto-kick)
// Dota2 inventory: steamcommunity.com/inventory + Steam Market prices (informational only, shown under CS2)
// Auto-kick via content-script DOM automation
// ============================================================

const PRICE_CACHE_MS = 30 * 60 * 1000;
const INVENTORY_CACHE_MS = 5 * 60 * 1000;
const CS2CAP_INVENTORY_CACHE_MS = 10 * 60 * 1000;
const STEAM_ID_CACHE_MS = 10 * 60 * 1000;
const CHECK_DELAY_MS = 850;
const MISSING_GRACE_MS = 10000;
const STEAM_ID64_BASE = 76561197960265728n;
const STEAM_INVENTORY_PAGE_SIZE = 2000;
const STEAM_INVENTORY_PAGE_SIZES = [2000, 1000, 500, 100];
const STEAM_INVENTORY_MAX_PAGES = 20;
const MAX_PARALLEL_PLAYER_CHECKS = 2;
const REJOIN_BLACKLIST_THRESHOLD = 3;
const REJOIN_TRACK_WINDOW_MS = 10 * 60 * 1000;
const PRICE_SOURCE_LABEL = 'Buff163';
const CS2CAP_INVENTORY_URL = 'https://cs2cap.com/api/inventory-value';
const USE_CS2CAP_FALLBACK = false;

// ---- Dota 2 inventory (added alongside CS2) ----
const CS2_APPID = 730;
const CS2_CONTEXTID = 2;
const DOTA_APPID = 570;
const DOTA_CONTEXTID = 2;
const DOTA_PRICE_SOURCE_LABEL = 'SteamMarket';
const DOTA_PRICE_CACHE_MS = 30 * 60 * 1000;
const DOTA_MARKET_THROTTLE_MS = 1200;
const DOTA_MAX_PRICE_LOOKUPS = 60;

const STATE = {
  isRunning: false,
  lobbyId: null,
  faceitApiKey: null,
  blacklist: [],
  whitelist: [],
  filters: {
    minCs2Value: 0,
    maxCs2Value: 999999,
    kickOnFail: true,
    kickIfNoData: false,
  },
  knownPlayers: new Map(),
  scanInterval: null,
  checkQueue: [],
  checkInFlight: false,
  activeChecks: 0,
  rejoinTracker: new Map(),
  buffPrices: null,
  buffPriceIndex: null,
  buffPricesPromise: null,
  buffPricesTs: 0,
  inventoryCache: new Map(),
  cs2CapInventoryCache: new Map(),
  steamIdCache: new Map(),
  lastInventoryRequestTs: 0,
  nextSteamRequestAt: 0,
  lastEmptyScanLog: 0,
  dotaPriceCache: new Map(),
  nextDotaMarketRequestAt: 0,
};

// ============================================================
// UTILS
// ============================================================

function notifyPopup(data) {
  try {
    const maybePromise = chrome.runtime.sendMessage({ action: 'parserEvent', data });
    if (maybePromise?.catch) maybePromise.catch(() => {});
  } catch (_) {}
}

function log(msg) {
  console.log(`[FaceIT Parser] ${msg}`);
  notifyPopup({ type: 'log', msg });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function normalizeNickname(nickname) {
  return String(nickname || '').trim();
}

function getKnown(nickname) {
  const lower = normalizeNickname(nickname).toLowerCase();
  for (const [key, value] of STATE.knownPlayers) {
    if (key.toLowerCase() === lower) return { key, value };
  }
  return { key: normalizeNickname(nickname), value: null };
}

function setKnown(nickname, entry) {
  const known = getKnown(nickname);
  STATE.knownPlayers.set(known.key || normalizeNickname(nickname), entry);
}

function trackerKey(nickname) {
  return normalizeNickname(nickname).toLowerCase();
}

function noteFilterKick(nickname) {
  const key = trackerKey(nickname);
  if (!key) return { count: 1, threshold: REJOIN_BLACKLIST_THRESHOLD };

  const now = nowMs();
  const previous = STATE.rejoinTracker.get(key);
  const count = previous && now - previous.lastKickAt <= REJOIN_TRACK_WINDOW_MS
    ? previous.count + 1
    : 1;
  const record = {
    nickname: normalizeNickname(nickname),
    count,
    threshold: REJOIN_BLACKLIST_THRESHOLD,
    lastKickAt: now,
  };
  STATE.rejoinTracker.set(key, record);
  return record;
}

function clearFilterKickSeries(nickname) {
  const key = trackerKey(nickname);
  if (key) STATE.rejoinTracker.delete(key);
}

async function addAutoBlacklist(nickname, record) {
  const nick = trackerKey(nickname);
  if (!nick || STATE.blacklist.includes(nick)) return false;

  STATE.blacklist.push(nick);
  try {
    const maybePromise = chrome.storage.local.set({ blacklist: STATE.blacklist });
    if (maybePromise?.catch) maybePromise.catch(() => {});
  } catch (_) {}

  log(`AUTO-BAN: ${nickname} failed filters ${record.count}/${record.threshold} times in a row — added to blacklist`);
  notifyPopup({
    type: 'autoBanned',
    nickname,
    count: record.count,
    threshold: record.threshold,
  });
  return true;
}

function readPositiveNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readNonNegativeNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readBuffPrice(priceEntry) {
  if (typeof priceEntry === 'number' || typeof priceEntry === 'string') {
    return readPositiveNumber(priceEntry);
  }

  const candidates = [
    priceEntry?.starting_at?.price,
    priceEntry?.buff163?.price,
    priceEntry?.price,
    priceEntry?.highest_order?.price,
    priceEntry?.sell?.price,
    priceEntry?.sell_price,
    priceEntry?.avg30,
    priceEntry?.average,
  ];

  for (const candidate of candidates) {
    const price = readPositiveNumber(candidate);
    if (price !== null) return price;
  }
  return null;
}

function normalizeMarketHashName(name) {
  return String(name || '')
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\|/g, ' |')
    .replace(/\|\s+/g, '| ')
    .replace(/stattrak\s*(?:tm|™)?/gi, 'stattrak')
    .replace(/[™®]/g, '')
    .replace(/★/g, 'star')
    .trim()
    .toLowerCase();
}

function buildBuffPriceIndex(data) {
  const index = new Map();
  for (const [name, entry] of Object.entries(data || {})) {
    const normalized = normalizeMarketHashName(name);
    if (!normalized) continue;

    const existingName = index.get(normalized);
    if (!existingName) {
      index.set(normalized, name);
      continue;
    }

    const existingPrice = readBuffPrice(data[existingName]);
    const nextPrice = readBuffPrice(entry);
    if (existingPrice === null && nextPrice !== null) index.set(normalized, name);
  }
  return index;
}

function findBuffPrice(prices, marketHashName) {
  if (!prices || !marketHashName) return { price: null, matchedName: null, matchType: 'missing' };

  if (Object.prototype.hasOwnProperty.call(prices, marketHashName)) {
    const exactPrice = readBuffPrice(prices[marketHashName]);
    if (exactPrice !== null) {
      return {
        price: exactPrice,
        matchedName: marketHashName,
        matchType: 'exact',
      };
    }
  }

  const normalized = normalizeMarketHashName(marketHashName);
  const matchedName = STATE.buffPriceIndex?.get(normalized) || null;
  if (!matchedName) return { price: null, matchedName: null, matchType: 'missing' };

  return {
    price: readBuffPrice(prices[matchedName]),
    matchedName,
    matchType: 'normalized',
  };
}

function makeInventoryResult(status, extra = {}) {
  return {
    value: null,
    status,
    source: PRICE_SOURCE_LABEL,
    provider: null,
    totalItems: 0,
    pricedItems: 0,
    unpricedItems: 0,
    pages: 0,
    unpricedSamples: [],
    ...extra,
  };
}

function inventoryStatusText(status) {
  const labels = {
    ok: 'ok',
    partial: 'partial price match',
    empty: 'empty CS2 inventory',
    private: 'private Steam inventory',
    rate_limited: 'Steam rate limited',
    price_data_unavailable: 'Buff163 price data unavailable',
    pricing_unavailable: 'Buff163 pricing source unavailable',
    no_priced_items: 'no Buff163 prices matched',
    no_steam_id: 'Steam ID not found',
    invalid_steam_id: 'invalid Steam ID',
    steam_error: 'Steam inventory error',
    inventory_unavailable: 'inventory data unavailable',
    no_data: 'inventory data unavailable',
  };
  return labels[status] || status || 'unknown';
}

function inventorySummary(result) {
  if (!result) return 'no inventory data';
  const total = result.totalItems ?? 0;
  const priced = result.pricedItems ?? 0;
  const source = `${result.source || PRICE_SOURCE_LABEL}${result.provider ? '@' + result.provider : ''}`;
  if (result.value === null || result.value === undefined) {
    return `${inventoryStatusText(result.status)} · ${priced}/${total} priced via ${source}`;
  }
  return `$${result.value.toFixed(2)} · ${priced}/${total} priced via ${source}`;
}

function applyInventoryResult(entry, result) {
  entry.inventory = result;
  entry.inventoryStatus = result?.status || null;
  entry.inventorySource = result?.source || PRICE_SOURCE_LABEL;
  entry.inventoryProvider = result?.provider || null;
  entry.totalItems = result?.totalItems || 0;
  entry.pricedItems = result?.pricedItems || 0;
  entry.unpricedItems = result?.unpricedItems || 0;
  entry.cs2Value = result?.value ?? null;
}

function isSteamId64(value) {
  return /^7656119\d{10}$/.test(String(value || ''));
}

// ============================================================
// CHROME TAB HELPERS
// ============================================================

function queryFaceitTabs() {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ url: ['https://*.faceit.com/*'] }, tabs => resolve(tabs || []));
    } catch (_) {
      resolve([]);
    }
  });
}

function tabScore(tab) {
  const url = tab.url || '';
  let score = 0;
  if (tab.active) score += 50;
  if (STATE.lobbyId && url.includes(STATE.lobbyId)) score += 100;
  if (/\/(?:room|hub|lobby|matchmaking|party)\//i.test(url)) score += 30;
  if (/faceit\.com/i.test(url)) score += 10;
  return score;
}

function sortFaceitTabs(tabs) {
  return [...tabs].sort((a, b) => tabScore(b) - tabScore(a));
}

function sendTabMessage(tabId, message) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, response => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, response });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

function injectContentScript(tabId) {
  return new Promise(resolve => {
    try {
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function sendToTabWithInjection(tabId, message) {
  let result = await sendTabMessage(tabId, message);
  if (result.ok) return result;

  const injected = await injectContentScript(tabId);
  if (!injected) return result;

  await sleep(150);
  return sendTabMessage(tabId, message);
}

async function getPlayersFromDOM() {
  const tabs = sortFaceitTabs(await queryFaceitTabs());
  let best = [];

  for (const tab of tabs) {
    const result = await sendToTabWithInjection(tab.id, { action: 'getPlayersFromDOM' });
    const players = result.response?.players || [];
    if (players.length > best.length) best = players;
    if (players.length && STATE.lobbyId && (tab.url || '').includes(STATE.lobbyId)) break;
  }

  return best;
}

async function kickPlayerDOM(nickname) {
  const tabs = sortFaceitTabs(await queryFaceitTabs());
  for (const tab of tabs) {
    const result = await sendToTabWithInjection(tab.id, { action: 'kickPlayer', nickname });
    if (result.response?.ok === true) return true;
  }
  return false;
}

async function playSound(type) {
  const tabs = await queryFaceitTabs();
  for (const tab of tabs) {
    sendTabMessage(tab.id, { action: 'playSound', type });
  }
}

// ============================================================
// STEAM INPUT NORMALIZATION
// ============================================================

function steamId64FromAccountId(accountId) {
  return (STEAM_ID64_BASE + BigInt(accountId)).toString();
}

async function resolveSteamVanity(vanity) {
  const clean = String(vanity || '').trim().replace(/^@/, '');
  if (!clean) throw new Error('Steam custom URL is empty');

  const cacheKey = `vanity:${clean.toLowerCase()}`;
  const cached = STATE.steamIdCache.get(cacheKey);
  if (cached && nowMs() - cached.ts < STEAM_ID_CACHE_MS) return cached.steamId;

  const url = `https://steamcommunity.com/id/${encodeURIComponent(clean)}?xml=1`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { Accept: 'application/xml,text/xml,*/*' },
  });
  if (!res.ok) throw new Error(`steam_profile_http_${res.status}`);

  const text = await res.text();
  const steamId = text.match(/<steamID64>(\d{17})<\/steamID64>/)?.[1];
  if (!steamId) {
    const xmlError = text.match(/<error><!\[CDATA\[(.*?)\]\]><\/error>/)?.[1]
      || text.match(/<error>(.*?)<\/error>/)?.[1];
    throw new Error(xmlError || 'Steam custom URL not found');
  }

  STATE.steamIdCache.set(cacheKey, { steamId, ts: nowMs() });
  return steamId;
}

async function resolveSteamInput(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) throw new Error('Enter SteamID64 or Steam profile URL');

  const communityProfile = input.match(/steamcommunity\.com\/profiles\/(\d+)/i)
    || input.match(/\/profiles\/(\d+)/i);
  if (communityProfile) {
    const digits = communityProfile[1];
    if (!/^\d{17}$/.test(digits)) {
      throw new Error(`SteamID64 must contain 17 digits, got ${digits.length}`);
    }
    return digits;
  }

  const directSteamId = input.match(/\b7656119\d{10}\b/)?.[0];
  if (directSteamId) return directSteamId;

  const accountId = input.match(/\[U:1:(\d+)\]/i)?.[1];
  if (accountId) return steamId64FromAccountId(accountId);

  let vanity = null;
  try {
    const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(withProtocol);
    if (/steamcommunity\.com$/i.test(url.hostname) || /\.steamcommunity\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0]?.toLowerCase() === 'id' && parts[1]) {
        vanity = decodeURIComponent(parts[1]);
      }
    }
  } catch (_) {
    if (/^[A-Za-z0-9_-]{2,64}$/.test(input)) vanity = input;
  }

  if (vanity) return resolveSteamVanity(vanity);

  const firstDigits = input.match(/\d+/)?.[0];
  if (firstDigits && firstDigits.length !== 17) {
    throw new Error(`SteamID64 must contain 17 digits, got ${firstDigits.length}`);
  }

  throw new Error('Enter SteamID64, /profiles/ URL, or /id/ custom URL');
}

// ============================================================
// FACEIT API - Steam ID by nickname
// ============================================================

function extractSteamIdFromFaceitPayload(data) {
  const payload = data?.payload || data || {};
  const candidates = [
    payload?.platforms?.steam?.id64,
    payload?.platforms?.steam,
    payload?.steam_id_64,
    payload?.new_steam_id,
    payload?.games?.cs2?.game_id,
    payload?.games?.csgo?.game_id,
    payload?.games?.cs2?.game_profile_id,
    payload?.games?.csgo?.game_profile_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isSteamId64(candidate)) return candidate;
  }

  return null;
}

function nicknameLookupVariants(nickname) {
  const cleanNick = normalizeNickname(nickname);
  const variants = [cleanNick];

  if (/[oO]/.test(cleanNick)) {
    variants.push(cleanNick.replace(/[oO]/g, match => match === 'O' ? '0' : '0'));
  }
  if (/0/.test(cleanNick)) {
    variants.push(cleanNick.replace(/0/g, 'O'));
  }
  if (/^[Ii]/.test(cleanNick)) {
    variants.push(cleanNick.replace(/^[Ii]/, 'l'));
  }
  if (/^l/.test(cleanNick)) {
    variants.push(cleanNick.replace(/^l/, 'I'));
  }
  if (/^[Ii]/.test(cleanNick) && /[oO]/.test(cleanNick)) {
    variants.push(cleanNick.replace(/^[Ii]/, 'l').replace(/[oO]/g, '0'));
  }

  return [...new Set(variants.filter(Boolean))];
}

async function fetchFaceitInternalUser(nickname, baseUrl) {
  const path = baseUrl.includes('api.faceit.com')
    ? `/users/v1/nicknames/${encodeURIComponent(nickname)}`
    : `/api/users/v1/nicknames/${encodeURIComponent(nickname)}`;
  const res = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(9000),
    headers: {
      Accept: 'application/json,*/*',
      'X-Requested-With': 'XMLHttpRequest',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolveSteamIdViaFaceitInternal(nickname) {
  for (const variant of nicknameLookupVariants(nickname)) {
    for (const baseUrl of ['https://api.faceit.com', 'https://www.faceit.com']) {
      try {
        const data = await fetchFaceitInternalUser(variant, baseUrl);
        const steamId = extractSteamIdFromFaceitPayload(data);
        if (steamId) {
          return {
            steamId,
            source: `${baseUrl.includes('www.') ? 'faceit-www' : 'faceit-users-v1'}${variant !== nickname ? `:${variant}` : ''}`,
            faceitNickname: data?.payload?.nickname || variant,
          };
        }
      } catch (_) {}
    }
  }

  return null;
}

async function resolveSteamIdViaFaceitOpen(nickname) {
  if (!STATE.faceitApiKey) return null;

  const cleanNick = normalizeNickname(nickname);
  const res = await fetch(
    `https://open.faceit.com/data/v4/players?nickname=${encodeURIComponent(cleanNick)}`,
    {
      headers: { Authorization: `Bearer ${STATE.faceitApiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const steamId = extractSteamIdFromFaceitPayload(data);
  return steamId ? { steamId, source: 'faceit-open-api', faceitNickname: data?.nickname || cleanNick } : null;
}

async function getSteamId(nickname) {
  const cleanNick = normalizeNickname(nickname);
  const cacheKey = `nick:${cleanNick.toLowerCase()}`;
  const cached = STATE.steamIdCache.get(cacheKey);
  if (cached && nowMs() - cached.ts < STEAM_ID_CACHE_MS) return cached;

  try {
    const internal = await resolveSteamIdViaFaceitInternal(cleanNick);
    if (internal?.steamId) {
      const result = { ...internal, ts: nowMs() };
      STATE.steamIdCache.set(cacheKey, result);
      log(`SteamID resolved for ${cleanNick}: ${internal.steamId} via ${internal.source}`);
      return result;
    }
  } catch (_) {
    try {
      const openApi = await resolveSteamIdViaFaceitOpen(cleanNick);
      if (openApi?.steamId) {
        const result = { ...openApi, ts: nowMs() };
        STATE.steamIdCache.set(cacheKey, result);
        log(`SteamID resolved for ${cleanNick}: ${openApi.steamId} via ${openApi.source}`);
        return result;
      }
    } catch (_) {
      return null;
    }
  }

  try {
    const openApi = await resolveSteamIdViaFaceitOpen(cleanNick);
    if (openApi?.steamId) {
      const result = { ...openApi, ts: nowMs() };
      STATE.steamIdCache.set(cacheKey, result);
      log(`SteamID resolved for ${cleanNick}: ${openApi.steamId} via ${openApi.source}`);
      return result;
    }
  } catch (_) {}

  return null;
}

// ============================================================
// BUFF PRICES - prices.csgotrader.app
// ============================================================

async function getBuffPrices() {
  const now = nowMs();
  if (STATE.buffPrices && now - STATE.buffPricesTs < PRICE_CACHE_MS) {
    return STATE.buffPrices;
  }
  if (STATE.buffPricesPromise) return STATE.buffPricesPromise;

  STATE.buffPricesPromise = (async () => {
    log('Loading Buff prices...');
    const res = await fetch('https://prices.csgotrader.app/latest/buff163.json', {
      signal: AbortSignal.timeout(25000),
      headers: {
        Accept: 'application/json,*/*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      cache: 'default',
      credentials: 'omit',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data || typeof data !== 'object' || !Object.keys(data).length) {
      throw new Error('empty price feed');
    }

    STATE.buffPrices = data;
    STATE.buffPriceIndex = buildBuffPriceIndex(data);
    STATE.buffPricesTs = now;
    log(`Buff163 prices loaded: ${Object.keys(data).length} items`);
    return data;
  })();

  try {
    return await STATE.buffPricesPromise;
  } catch (e) {
    log(`Buff163 prices failed: ${e.message}${STATE.buffPrices ? ' (using cache)' : ''}`);
    return STATE.buffPrices || null;
  } finally {
    STATE.buffPricesPromise = null;
  }
}

// ============================================================
// STEAM INVENTORY
// ============================================================

async function throttleSteamInventoryRequest() {
  const waitUntil = Math.max(
    STATE.nextSteamRequestAt,
    STATE.lastInventoryRequestTs + CHECK_DELAY_MS
  );
  const waitMs = waitUntil - nowMs();
  if (waitMs > 0) await sleep(waitMs);
  STATE.lastInventoryRequestTs = nowMs();
}

function centsToUsd(value) {
  const cents = readNonNegativeNumber(value);
  return cents === null ? null : cents / 100;
}

function cs2CapBuffPrice(item) {
  const buff = (item?.providers || []).find(provider =>
    String(provider?.provider || '').toLowerCase() === 'buff163'
  );
  return centsToUsd(buff?.lowest_ask);
}

function parseCs2CapInventory(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const unmatched = Array.isArray(data?.unmatched_items) ? data.unmatched_items : [];

  let total = 0;
  let pricedItems = 0;
  let unpricedItems = 0;
  const unpricedSamples = [];

  for (const item of items) {
    const quantity = parseInt(item?.quantity, 10) || 1;
    const buffPrice = cs2CapBuffPrice(item);
    if (buffPrice === null) {
      unpricedItems += quantity;
      if (unpricedSamples.length < 5) unpricedSamples.push(item?.market_hash_name || 'Unknown item');
      continue;
    }

    total += buffPrice * quantity;
    pricedItems += quantity;
  }

  for (const item of unmatched) {
    const quantity = parseInt(item?.quantity, 10) || 1;
    unpricedItems += quantity;
    if (unpricedSamples.length < 5) unpricedSamples.push(item?.market_hash_name || 'Unknown item');
  }

  const totalItems = pricedItems + unpricedItems;
  if (!totalItems) {
    return makeInventoryResult('empty', {
      value: 0,
      source: PRICE_SOURCE_LABEL,
      provider: 'cs2cap',
      raw: data,
    });
  }

  if (!pricedItems) {
    return makeInventoryResult('no_priced_items', {
      totalItems,
      unpricedItems,
      source: PRICE_SOURCE_LABEL,
      provider: 'cs2cap',
      unpricedSamples,
      raw: data,
    });
  }

  return makeInventoryResult(unpricedItems ? 'partial' : 'ok', {
    value: total,
    totalItems,
    pricedItems,
    unpricedItems,
    source: PRICE_SOURCE_LABEL,
    provider: 'cs2cap',
    unpricedSamples,
    raw: data,
  });
}

async function getCs2CapInventoryValue(steamId) {
  const cached = STATE.cs2CapInventoryCache.get(steamId);
  if (cached && nowMs() - cached.ts < CS2CAP_INVENTORY_CACHE_MS) return cached.result;

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(CS2CAP_INVENTORY_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(35000),
        headers: {
          Accept: 'application/json,*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ steam_id: steamId }),
        cache: 'no-store',
      });

      if (!res.ok) throw new Error(`cs2cap_http_${res.status}`);
      const data = await res.json();
      const result = parseCs2CapInventory(data);
      STATE.cs2CapInventoryCache.set(steamId, { result, ts: nowMs() });
      return result;
    } catch (e) {
      lastError = e;
      if (attempt < 2) await sleep(1300);
    }
  }

  throw lastError || new Error('cs2cap_failed');
}

function normalizeLegacySteamInventory(data) {
  if (!data?.rgInventory || !data?.rgDescriptions) return null;

  const assets = Object.values(data.rgInventory).map(asset => ({
    ...asset,
    amount: asset?.amount || '1',
  }));

  const descriptions = Object.entries(data.rgDescriptions).map(([key, desc]) => {
    const [classid, instanceid] = key.split('_');
    return {
      ...desc,
      classid: desc?.classid || classid,
      instanceid: desc?.instanceid || instanceid || '0',
      market_hash_name: desc?.market_hash_name || desc?.market_name || desc?.name,
    };
  });

  return {
    success: data.success,
    assets,
    descriptions,
    more_items: false,
    last_assetid: null,
    pages: 1,
  };
}

function steamInventoryUrls(steamId, startAssetId, count, appId = CS2_APPID, contextId = CS2_CONTEXTID) {
  const params = new URLSearchParams({
    l: 'english',
    count: String(count),
  });
  if (startAssetId) params.set('start_assetid', startAssetId);

  const urls = [{
    type: 'inventory',
    url: `https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}?${params.toString()}`,
  }];

  if (!startAssetId) {
    const legacyParams = new URLSearchParams({ l: 'english', count: String(count) });
    urls.push({
      type: 'legacy',
      url: `https://steamcommunity.com/profiles/${steamId}/inventory/json/${appId}/${contextId}?${legacyParams.toString()}`,
    });
  }

  return urls;
}

async function fetchSteamInventoryJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(22000),
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    cache: 'no-store',
    credentials: 'omit',
  });

  if (res.status === 401 || res.status === 403) throw new Error('private_inventory');
  if (res.status === 429) {
    STATE.nextSteamRequestAt = nowMs() + 20000;
    throw new Error('rate_limited');
  }
  if (!res.ok) throw new Error(`steam_http_${res.status}`);

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('steam_bad_json');
  }
}

async function fetchSteamInventoryPage(steamId, startAssetId = null, appId = CS2_APPID, contextId = CS2_CONTEXTID) {
  let lastError = null;

  for (const count of STEAM_INVENTORY_PAGE_SIZES) {
    for (const candidate of steamInventoryUrls(steamId, startAssetId, count, appId, contextId)) {
      await throttleSteamInventoryRequest();

      try {
        const data = await fetchSteamInventoryJson(candidate.url);
        const normalized = candidate.type === 'legacy'
          ? normalizeLegacySteamInventory(data)
          : data;

        if (!normalized || normalized.success === false) {
          const detail = data?.Error || data?.error || 'steam_no_success';
          if (/private/i.test(String(detail))) throw new Error('private_inventory');
          throw new Error(String(detail));
        }

        normalized.requestCount = count;
        normalized.requestType = candidate.type;
        return normalized;
      } catch (e) {
        lastError = e;
        if (e.message === 'private_inventory' || e.message === 'rate_limited') throw e;
        if (!/^steam_http_400$/.test(e.message) && e.message !== 'steam_bad_json') {
          break;
        }
      }
    }
  }

  throw lastError || new Error('steam_inventory_failed');
}

async function getSteamInventory(steamId, appId = CS2_APPID, contextId = CS2_CONTEXTID) {
  const cacheKey = `${steamId}:${appId}`;
  const cached = STATE.inventoryCache.get(cacheKey);
  if (cached && nowMs() - cached.ts < INVENTORY_CACHE_MS) return cached.data;

  const assets = [];
  const descriptions = new Map();
  let firstPage = null;
  let startAssetId = null;
  let pages = 0;

  do {
    const page = await fetchSteamInventoryPage(steamId, startAssetId, appId, contextId);
    if (!firstPage) firstPage = page;
    pages++;

    for (const asset of page.assets || []) assets.push(asset);
    for (const desc of page.descriptions || []) {
      descriptions.set(`${desc.classid}_${desc.instanceid}`, desc);
    }

    if (!page.more_items || !page.last_assetid || page.last_assetid === startAssetId) break;
    startAssetId = page.last_assetid;
    await sleep(350);
  } while (pages < STEAM_INVENTORY_MAX_PAGES);

  const data = {
    ...(firstPage || {}),
    assets,
    descriptions: [...descriptions.values()],
    pages,
  };

  STATE.inventoryCache.set(cacheKey, { data, ts: nowMs() });
  return data;
}

async function getSteamInventoryWithRetry(steamId, appId = CS2_APPID, contextId = CS2_CONTEXTID) {
  try {
    return await getSteamInventory(steamId, appId, contextId);
  } catch (e) {
    if (e.message !== 'rate_limited') throw e;
    log('Steam rate limit detected; backing off before retry');
    await sleep(12000);
    return getSteamInventory(steamId, appId, contextId);
  }
}

function countSteamInventoryItems(inv) {
  return (inv?.assets || []).reduce((sum, asset) => {
    return sum + (parseInt(asset?.amount, 10) || 1);
  }, 0);
}

function valueSteamInventoryWithBuffPrices(inv, prices, steamId) {
  const assets = inv.assets || [];
  const descriptions = inv.descriptions || [];
  const pages = inv.pages || 1;
  if (!assets.length) {
    return makeInventoryResult('empty', { value: 0, pages, provider: 'steam' });
  }

  const descMap = new Map();
  for (const d of descriptions) {
    if (d.market_hash_name) descMap.set(`${d.classid}_${d.instanceid}`, d.market_hash_name);
  }

  let total = 0;
  let totalItems = 0;
  let pricedItems = 0;
  let unpricedItems = 0;
  let normalizedMatches = 0;
  const unpricedSamples = [];

  for (const asset of assets) {
    const amount = parseInt(asset.amount, 10) || 1;
    totalItems += amount;

    const name = descMap.get(`${asset.classid}_${asset.instanceid}`);
    if (!name) {
      unpricedItems += amount;
      continue;
    }

    const match = findBuffPrice(prices, name);
    if (match.price === null) {
      unpricedItems += amount;
      if (unpricedSamples.length < 5) unpricedSamples.push(name);
      continue;
    }

    total += match.price * amount;
    pricedItems += amount;
    if (match.matchType === 'normalized') normalizedMatches += amount;
  }

  if (!pricedItems) {
    const result = makeInventoryResult('no_priced_items', {
      totalItems,
      unpricedItems,
      pages,
      unpricedSamples,
      provider: 'steam',
    });
    log(`No Buff163 prices matched for SteamID ${steamId}. Items: ${totalItems}`);
    return result;
  }

  return makeInventoryResult(unpricedItems ? 'partial' : 'ok', {
    value: total,
    totalItems,
    pricedItems,
    unpricedItems,
    normalizedMatches,
    pages,
    unpricedSamples,
    provider: 'steam',
  });
}

async function maybeGetCs2CapFallback(steamId, enabled) {
  if (!enabled && !USE_CS2CAP_FALLBACK) return null;

  try {
    const cs2CapResult = await getCs2CapInventoryValue(steamId);
    log(`CS2 inventory via CS2Cap/Buff163: ${inventorySummary(cs2CapResult)}`);
    return cs2CapResult;
  } catch (e) {
    log(`CS2Cap inventory fallback failed for ${steamId}: ${e.message}`);
    return makeInventoryResult('inventory_unavailable', {
      error: `CS2Cap: ${e.message}`,
      provider: 'cs2cap',
    });
  }
}

async function getCs2InventoryValue(steamId, options = {}) {
  if (!steamId) return makeInventoryResult('no_steam_id');
  if (!isSteamId64(steamId)) {
    return makeInventoryResult('invalid_steam_id', {
      error: `Expected SteamID64, got ${String(steamId).length} chars`,
    });
  }

  const [priceState, inventoryState] = await Promise.allSettled([
    getBuffPrices(),
    getSteamInventoryWithRetry(steamId),
  ]);

  const prices = priceState.status === 'fulfilled' ? priceState.value : null;

  if (inventoryState.status === 'fulfilled') {
    const inv = inventoryState.value;

    if (!prices) {
      const totalItems = countSteamInventoryItems(inv);
      const cs2CapResult = await maybeGetCs2CapFallback(steamId, options.useCs2CapFallback === true);
      if (cs2CapResult?.value !== null && cs2CapResult?.value !== undefined) return cs2CapResult;

      return makeInventoryResult('pricing_unavailable', {
        error: 'Buff feed unavailable',
        totalItems,
        unpricedItems: totalItems,
        pages: inv.pages || 1,
        provider: 'steam',
      });
    }

    const result = valueSteamInventoryWithBuffPrices(inv, prices, steamId);
    log(`CS2 inventory via Steam/Buff163: ${inventorySummary(result)}`);
    return result;
  }

  const steamError = inventoryState.reason;
  if (steamError?.message === 'private_inventory') {
    notifyPopup({ type: 'inventoryStatus', steamId, status: 'private' });
    return makeInventoryResult('private', { provider: 'steam' });
  }

  if (steamError?.message === 'rate_limited') {
    return makeInventoryResult('rate_limited', {
      error: 'Steam rate limited',
      provider: 'steam',
    });
  }

  const cs2CapResult = await maybeGetCs2CapFallback(steamId, options.useCs2CapFallback === true);
  if (cs2CapResult?.value !== null && cs2CapResult?.value !== undefined) return cs2CapResult;

  log(`Steam inventory error for ${steamId}: ${steamError?.message || 'unknown'}`);
  return makeInventoryResult('steam_error', {
    error: `Steam: ${steamError?.message || 'unknown'}`,
    provider: 'steam',
  });
}

async function getCs2Value(steamId, options = {}) {
  const result = await getCs2InventoryValue(steamId, options);
  return result.value;
}

// ============================================================
// DOTA 2 INVENTORY - steamcommunity.com market priceoverview
// (no bulk Buff163 feed exists for Dota2, so prices are fetched
// per unique item name and cached)
// ============================================================

function parseSteamMarketPrice(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/[^0-9.,]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function throttleDotaMarketRequest() {
  const waitUntil = Math.max(STATE.nextDotaMarketRequestAt, nowMs());
  const waitMs = waitUntil - nowMs();
  if (waitMs > 0) await sleep(waitMs);
  STATE.nextDotaMarketRequestAt = nowMs() + DOTA_MARKET_THROTTLE_MS;
}

async function fetchDotaMarketPrice(marketHashName) {
  const cacheKey = marketHashName.toLowerCase();
  const cached = STATE.dotaPriceCache.get(cacheKey);
  if (cached && nowMs() - cached.ts < DOTA_PRICE_CACHE_MS) return cached.price;

  await throttleDotaMarketRequest();

  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=${DOTA_APPID}&currency=1&market_hash_name=${encodeURIComponent(marketHashName)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(9000),
      headers: { Accept: 'application/json,*/*' },
      cache: 'no-store',
      credentials: 'omit',
    });

    if (res.status === 429) {
      STATE.nextDotaMarketRequestAt = nowMs() + 20000;
      throw new Error('rate_limited');
    }
    if (!res.ok) throw new Error(`steam_market_http_${res.status}`);

    const data = await res.json();
    const price = data?.success
      ? (parseSteamMarketPrice(data.lowest_price) ?? parseSteamMarketPrice(data.median_price))
      : null;

    STATE.dotaPriceCache.set(cacheKey, { price, ts: nowMs() });
    return price;
  } catch (e) {
    if (e.message === 'rate_limited') throw e;
    STATE.dotaPriceCache.set(cacheKey, { price: null, ts: nowMs() });
    return null;
  }
}

async function valueDota2InventoryWithMarketPrices(inv) {
  const assets = inv.assets || [];
  const descriptions = inv.descriptions || [];
  const pages = inv.pages || 1;

  if (!assets.length) {
    return makeInventoryResult('empty', { value: 0, pages, provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL });
  }

  const descMap = new Map();
  for (const d of descriptions) {
    if (d.marketable === 0 || d.marketable === false) continue;
    if (d.market_hash_name) descMap.set(`${d.classid}_${d.instanceid}`, d.market_hash_name);
  }

  let totalItems = 0;
  const countByName = new Map();
  for (const asset of assets) {
    const amount = parseInt(asset.amount, 10) || 1;
    totalItems += amount;
    const name = descMap.get(`${asset.classid}_${asset.instanceid}`);
    if (!name) continue;
    countByName.set(name, (countByName.get(name) || 0) + amount);
  }

  const uniqueNames = [...countByName.keys()];
  const namesToPrice = uniqueNames.slice(0, DOTA_MAX_PRICE_LOOKUPS);
  const namesSkipped = uniqueNames.slice(DOTA_MAX_PRICE_LOOKUPS);

  let total = 0;
  let pricedItems = 0;
  let unpricedItems = 0;
  const unpricedSamples = [];
  let rateLimited = false;

  for (const name of namesToPrice) {
    const amount = countByName.get(name);
    let price = null;
    if (!rateLimited) {
      try {
        price = await fetchDotaMarketPrice(name);
      } catch (e) {
        if (e.message === 'rate_limited') rateLimited = true;
      }
    }
    if (price === null) {
      unpricedItems += amount;
      if (unpricedSamples.length < 5) unpricedSamples.push(name);
      continue;
    }
    total += price * amount;
    pricedItems += amount;
  }

  for (const name of namesSkipped) {
    unpricedItems += countByName.get(name);
    if (unpricedSamples.length < 5) unpricedSamples.push(name);
  }

  // Items with no marketable name are unpriced too.
  unpricedItems = Math.max(unpricedItems, totalItems - pricedItems);

  if (rateLimited && !pricedItems) {
    return makeInventoryResult('rate_limited', {
      error: 'Steam Market rate limited',
      totalItems, unpricedItems, pages, provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL,
    });
  }

  if (!pricedItems) {
    return makeInventoryResult('no_priced_items', {
      totalItems, unpricedItems, pages, unpricedSamples, provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL,
    });
  }

  return makeInventoryResult(unpricedItems ? 'partial' : 'ok', {
    value: total, totalItems, pricedItems, unpricedItems, pages, unpricedSamples,
    provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL,
  });
}

async function getDota2InventoryValue(steamId) {
  if (!steamId) return makeInventoryResult('no_steam_id', { source: DOTA_PRICE_SOURCE_LABEL });
  if (!isSteamId64(steamId)) {
    return makeInventoryResult('invalid_steam_id', {
      error: `Expected SteamID64, got ${String(steamId).length} chars`,
      source: DOTA_PRICE_SOURCE_LABEL,
    });
  }

  try {
    const inv = await getSteamInventoryWithRetry(steamId, DOTA_APPID, DOTA_CONTEXTID);
    const result = await valueDota2InventoryWithMarketPrices(inv);
    log(`Dota2 inventory via Steam Market: ${inventorySummary(result)}`);
    return result;
  } catch (e) {
    if (e.message === 'private_inventory') {
      notifyPopup({ type: 'inventoryStatus', steamId, status: 'private', game: 'dota2' });
      return makeInventoryResult('private', { provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL });
    }
    if (e.message === 'rate_limited') {
      return makeInventoryResult('rate_limited', {
        error: 'Steam rate limited', provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL,
      });
    }
    log(`Dota2 inventory error for ${steamId}: ${e.message}`);
    return makeInventoryResult('steam_error', {
      error: `Steam: ${e.message}`, provider: 'steam', source: DOTA_PRICE_SOURCE_LABEL,
    });
  }
}

// ============================================================
// FILTERS
// ============================================================

function passesFilters(cs2Value) {
  const min = parseFloat(STATE.filters.minCs2Value) || 0;
  const max = parseFloat(STATE.filters.maxCs2Value) || 999999;

  if (cs2Value === null || cs2Value === undefined) {
    return !STATE.filters.kickIfNoData;
  }

  const val = parseFloat(cs2Value);
  if (Number.isNaN(val)) return !STATE.filters.kickIfNoData;

  const passes = val >= min && val <= max;
  log(`Filter check: $${val.toFixed(0)} in [$${min}-$${max}] -> ${passes ? 'PASS' : 'FAIL'}`);
  return passes;
}

// ============================================================
// LOBBY PROCESSING
// ============================================================

function enqueuePlayerCheck(nickname) {
  const cleanNick = normalizeNickname(nickname);
  if (!cleanNick) return;

  const lower = cleanNick.toLowerCase();
  if (STATE.checkQueue.some(n => n.toLowerCase() === lower)) return;

  STATE.checkQueue.push(cleanNick);
  processCheckQueue();
}

function processCheckQueue() {
  if (!STATE.isRunning) return;

  while (STATE.activeChecks < MAX_PARALLEL_PLAYER_CHECKS && STATE.checkQueue.length) {
    const nickname = STATE.checkQueue.shift();
    if (!nickname) continue;

    const known = getKnown(nickname).value;
    if (!known || !known.checking) continue;

    STATE.activeChecks += 1;
    STATE.checkInFlight = true;

    checkPlayer(nickname).finally(() => {
      STATE.activeChecks = Math.max(0, STATE.activeChecks - 1);
      STATE.checkInFlight = STATE.activeChecks > 0;
      if (STATE.isRunning) setTimeout(processCheckQueue, CHECK_DELAY_MS);
    });
  }
}

function processLobbyPlayers(players) {
  if (!STATE.isRunning || !Array.isArray(players)) return;

  const byLowerNick = new Map();
  for (const player of players) {
    const nickname = normalizeNickname(player?.nickname);
    if (!nickname) continue;
    byLowerNick.set(nickname.toLowerCase(), { ...player, nickname });
  }

  if (!byLowerNick.size) return;

  const now = nowMs();

  for (const [nick, entry] of STATE.knownPlayers) {
    if (byLowerNick.has(nick.toLowerCase())) {
      if (entry.kicked && entry.missingSince) entry.rejoinedAfterKick = true;
      delete entry.missingSince;
      entry.lastSeen = now;
      continue;
    }

    if (!entry.missingSince) {
      entry.missingSince = now;
      STATE.knownPlayers.set(nick, entry);
    } else if (now - entry.missingSince > MISSING_GRACE_MS) {
      STATE.knownPlayers.delete(nick);
      notifyPopup({ type: 'left', nickname: nick });
    }
  }

  for (const player of byLowerNick.values()) {
    const nickname = player.nickname;
    const lower = nickname.toLowerCase();
    const knownInfo = getKnown(nickname);
    const known = knownInfo.value;

    if (known?.whitelisted) {
      known.lastSeen = now;
      known.hasKickButton = player.hasKickButton;
      delete known.missingSince;
      STATE.knownPlayers.set(knownInfo.key, known);
      notifyPopup({ type: 'update', nickname: knownInfo.key, cs2Value: known.cs2Value, inventory: known.inventory, dotaValue: known.dotaValue, dotaInventory: known.dotaInventory });
      continue;
    }

    // Keep a kicked player quiet while FACEIT still shows the old row.
    // If they disappeared and came back, run a fresh filter check first.
    if (known?.kicked) {
      if (known.rejoinedAfterKick) {
        const entry = {
          checking: true,
          joinTime: now,
          lastSeen: now,
          hasKickButton: player.hasKickButton,
        };
        setKnown(nickname, entry);
        notifyPopup({ type: 'checking', nickname });
        enqueuePlayerCheck(nickname);
        continue;
      }

      known.lastSeen = now;
      known.hasKickButton = player.hasKickButton;
      delete known.missingSince;
      delete known.rejoinedAfterKick;
      STATE.knownPlayers.set(knownInfo.key, known);
      continue;
    }

    if (known?.checked) {
      known.lastSeen = now;
      known.hasKickButton = player.hasKickButton;
      delete known.missingSince;
      STATE.knownPlayers.set(knownInfo.key, known);
      notifyPopup({ type: 'update', nickname: knownInfo.key, cs2Value: known.cs2Value, inventory: known.inventory, dotaValue: known.dotaValue, dotaInventory: known.dotaInventory });
      continue;
    }

    if (known?.checking) {
      known.lastSeen = now;
      known.hasKickButton = player.hasKickButton;
      delete known.missingSince;
      STATE.knownPlayers.set(knownInfo.key, known);
      continue;
    }

    if (STATE.blacklist.includes(lower)) {
      const entry = {
        kicked: true,
        checked: true,
        joinTime: now,
        lastSeen: now,
        reason: 'blacklist',
        hasKickButton: player.hasKickButton,
      };
      setKnown(nickname, entry);
      notifyPopup({ type: 'kicked', nickname, reason: 'blacklist', cs2Value: null });
      kickPlayerDOM(nickname).then(ok => {
        if (ok) playSound('kick');
        else notifyPopup({ type: 'kickFailed', nickname, cs2Value: null });
      });
      continue;
    }

    if (STATE.whitelist.includes(lower)) {
      clearFilterKickSeries(nickname);
      const entry = {
        whitelisted: true,
        checked: true,
        joinTime: now,
        lastSeen: now,
        hasKickButton: player.hasKickButton,
      };
      setKnown(nickname, entry);
      notifyPopup({ type: 'whitelisted', nickname });
      playSound('pass');
      continue;
    }

    const entry = {
      checking: true,
      joinTime: now,
      lastSeen: now,
      hasKickButton: player.hasKickButton,
    };
    setKnown(nickname, entry);
    notifyPopup({ type: 'checking', nickname });
    enqueuePlayerCheck(nickname);
  }
}

async function scanLobby() {
  if (!STATE.isRunning) return;

  try {
    const players = await getPlayersFromDOM();
    if (!players.length) {
      if (nowMs() - STATE.lastEmptyScanLog > 10000) {
        STATE.lastEmptyScanLog = nowMs();
        log('No lobby players found in FACEIT DOM yet. Keep the FACEIT lobby tab open.');
      }
      return;
    }

    processLobbyPlayers(players);
  } catch (e) {
    log(`Scan error: ${e.message}`);
  }
}

async function checkPlayer(nickname) {
  const knownInfo = getKnown(nickname);
  const entry = knownInfo.value || { joinTime: nowMs() };

  if (!entry.checking) return;

  try {
    const steamInfo = await getSteamId(nickname);
    const steamId = steamInfo?.steamId || null;
    entry.steamId = steamId;
    entry.steamResolveSource = steamInfo?.source || null;
    entry.faceitNickname = steamInfo?.faceitNickname || nickname;
    if (!steamId) log(`No Steam ID for: ${nickname}. Add a FACEIT API key in Settings for automatic inventory checks.`);

    const inventory = steamId
      ? await getCs2InventoryValue(steamId)
      : makeInventoryResult('no_steam_id');
    applyInventoryResult(entry, inventory);

    // Dota2 inventory value is informational only — never affects pass/kick decisions.
    let dotaInventory;
    try {
      dotaInventory = steamId
        ? await getDota2InventoryValue(steamId)
        : makeInventoryResult('no_steam_id', { source: DOTA_PRICE_SOURCE_LABEL });
    } catch (e) {
      dotaInventory = makeInventoryResult('steam_error', { error: e.message, source: DOTA_PRICE_SOURCE_LABEL });
    }
    entry.dotaInventory = dotaInventory;
    entry.dotaValue = dotaInventory?.value ?? null;

    const stillKnown = getKnown(nickname);
    if (!stillKnown.value) return;

    const cs2Value = entry.cs2Value;
    const hasInventoryValue = cs2Value !== null && cs2Value !== undefined && !Number.isNaN(parseFloat(cs2Value));
    const passes = hasInventoryValue ? passesFilters(cs2Value) : false;
    entry.checked = true;
    entry.checking = false;
    entry.lastSeen = nowMs();

    if (!hasInventoryValue && !STATE.filters.kickIfNoData) {
      clearFilterKickSeries(nickname);
      entry.noData = true;
      entry.reason = inventory.status || 'no_data';
      setKnown(nickname, entry);
      log(`NO DATA: ${nickname} ${inventorySummary(inventory)} - not kicked because kickIfNoData is off`);
      notifyPopup({ type: 'noData', nickname, steamId, cs2Value: null, inventory, dotaValue: entry.dotaValue, dotaInventory: entry.dotaInventory });
      return;
    }

    if (passes) {
      clearFilterKickSeries(nickname);
      entry.passed = true;
      setKnown(nickname, entry);
      log(`PASS: ${nickname} ${inventorySummary(inventory)}`);
      playSound('pass');
      notifyPopup({ type: 'passed', nickname, steamId, cs2Value, inventory, dotaValue: entry.dotaValue, dotaInventory: entry.dotaInventory });
      return;
    }

    let filterKickRecord = null;
    let autoBlacklisted = false;
    if (STATE.filters.kickOnFail) {
      filterKickRecord = noteFilterKick(nickname);
      entry.filterKickCount = filterKickRecord.count;
      entry.filterKickThreshold = filterKickRecord.threshold;
      if (filterKickRecord.count >= filterKickRecord.threshold) {
        autoBlacklisted = await addAutoBlacklist(nickname, filterKickRecord);
      }
    }

    entry.kicked = true;
    entry.reason = autoBlacklisted ? 'auto_blacklist' : 'filters';
    setKnown(nickname, entry);
    const seriesText = filterKickRecord ? ` (${filterKickRecord.count}/${filterKickRecord.threshold})` : '';
    log(`FAIL: ${nickname} ${inventorySummary(inventory)} - kicking${seriesText}`);
    notifyPopup({ type: 'kicked', nickname, reason: entry.reason, cs2Value, inventory, dotaValue: entry.dotaValue, dotaInventory: entry.dotaInventory });

    if (!STATE.filters.kickOnFail) return;

    let kicked = false;
    for (let attempt = 1; attempt <= 4 && !kicked; attempt++) {
      kicked = await kickPlayerDOM(nickname);
      if (!kicked) await sleep(900 + attempt * 350);
    }

    if (kicked) {
      playSound('kick');
      log(`Kicked: ${nickname}`);
    } else {
      log(`Could not auto-kick ${nickname}; FACEIT lobby tab must be open`);
      notifyPopup({ type: 'kickFailed', nickname, cs2Value });
    }
  } catch (e) {
    log(`Error checking ${nickname}: ${e.message}`);
    const known = getKnown(nickname);
    if (known.value?.checking) STATE.knownPlayers.delete(known.key);
  }
}

// ============================================================
// START / STOP
// ============================================================

function startScanning(lobbyId) {
  if (STATE.isRunning) return;

  if (lobbyId) {
    STATE.lobbyId = lobbyId;
    try {
      const maybePromise = chrome.storage.local.set({ lobbyId });
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {}
  }

  STATE.isRunning = true;
  STATE.knownPlayers.clear();
  STATE.rejoinTracker.clear();
  STATE.checkQueue = [];
  STATE.checkInFlight = false;
  STATE.activeChecks = 0;
  STATE.lastEmptyScanLog = 0;

  log('Parser started');
  scanLobby();
  STATE.scanInterval = setInterval(scanLobby, 2000);
}

function stopScanning() {
  STATE.isRunning = false;
  clearInterval(STATE.scanInterval);
  STATE.scanInterval = null;
  STATE.knownPlayers.clear();
  STATE.rejoinTracker.clear();
  STATE.checkQueue = [];
  STATE.checkInFlight = false;
  STATE.activeChecks = 0;
  log('Parser stopped');
}

// ============================================================
// SETTINGS
// ============================================================

async function loadSettings() {
  const d = await chrome.storage.local.get(['faceitApiKey', 'blacklist', 'whitelist', 'filters', 'lobbyId']);
  if (d.faceitApiKey) STATE.faceitApiKey = d.faceitApiKey;
  if (d.blacklist) STATE.blacklist = d.blacklist.map(n => String(n).toLowerCase());
  if (d.whitelist) STATE.whitelist = d.whitelist.map(n => String(n).toLowerCase());
  if (d.filters) STATE.filters = { ...STATE.filters, ...d.filters };
  if (d.lobbyId) STATE.lobbyId = d.lobbyId;
}

// ============================================================
// MESSAGES
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case 'start':
        await loadSettings();
        startScanning(msg.lobbyId);
        sendResponse({ ok: true });
        break;

      case 'stop':
        stopScanning();
        sendResponse({ ok: true });
        break;

      case 'getState':
        sendResponse({
          isRunning: STATE.isRunning,
          lobbyId: STATE.lobbyId,
          players: Object.fromEntries(STATE.knownPlayers),
        });
        break;

      case 'checkInventory': {
        try {
          const steamId = await resolveSteamInput(msg.steamInput || msg.steamId);
          const [inventory, dotaInventory] = await Promise.all([
            getCs2InventoryValue(steamId, { strict: true }),
            getDota2InventoryValue(steamId),
          ]);
          sendResponse({
            value: inventory.value,
            steamId,
            inventory,
            dotaValue: dotaInventory.value,
            dotaInventory,
            pricesLoaded: !!STATE.buffPrices,
            error: inventory.value === null
              ? `${inventoryStatusText(inventory.status)}${inventory.error ? ` (${inventory.error})` : ''}`
              : null,
          });
        } catch (e) {
          sendResponse({ value: null, error: e.message });
        }
        break;
      }

      case 'reloadSettings':
        await loadSettings();
        sendResponse({ ok: true });
        break;

      case 'getPlayerData': {
        const player = getKnown(msg.nickname).value || {};
        sendResponse({ player, filters: STATE.filters });
        break;
      }

      case 'addToList': {
        await loadSettings();
        const nick = normalizeNickname(msg.nickname).toLowerCase();
        if (msg.list === 'whitelist') {
          if (!STATE.whitelist.includes(nick)) STATE.whitelist.push(nick);
          await chrome.storage.local.set({ whitelist: STATE.whitelist });
          log('Whitelist: ' + nick);
        } else {
          if (!STATE.blacklist.includes(nick)) STATE.blacklist.push(nick);
          await chrome.storage.local.set({ blacklist: STATE.blacklist });
          log('Blacklist: ' + nick);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'contentLog':
        notifyPopup({ type: 'log', msg: `[DOM] ${msg.msg}` });
        sendResponse({ ok: true });
        break;

      case 'pageInfo':
        if (!STATE.lobbyId && msg.lobbyId) {
          STATE.lobbyId = msg.lobbyId;
          log(`Lobby detected: ${msg.lobbyId}`);
          notifyPopup({ type: 'lobbyDetected', lobbyId: msg.lobbyId });
        }
        if (STATE.isRunning && Array.isArray(msg.players)) processLobbyPlayers(msg.players);
        sendResponse({ ok: true });
        break;

      case 'domPlayers':
        if (STATE.isRunning && Array.isArray(msg.players)) processLobbyPlayers(msg.players);
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: 'Unknown action' });
    }
  })();
  return true;
});

loadSettings();
