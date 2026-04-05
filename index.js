// filename: index.js
'use strict';

// ─── Global crash guards ───────────────────────────────────────────────────────
// Prevent the process from dying on unhandled promise rejections (e.g. the
// Windows EBUSY Puppeteer bug, stray fetch failures, etc.)
process.on('unhandledRejection', (err) => {
  const msg = err?.message ?? String(err);
  // EBUSY is a known Windows Puppeteer cleanup glitch — log dimly, don't crash
  if (err?.code === 'EBUSY' || msg.includes('EBUSY')) {
    console.warn('\x1b[90m[Guard] Suppressed EBUSY temp-profile lock (Windows/Puppeteer)\x1b[0m');
    return;
  }
  console.error('\x1b[31m[Unhandled Rejection]\x1b[0m', msg);
});

process.on('uncaughtException', (err) => {
  const msg = err?.message ?? String(err);
  if (err?.code === 'EBUSY' || msg.includes('EBUSY')) {
    console.warn('\x1b[90m[Guard] Suppressed EBUSY temp-profile lock (Windows/Puppeteer)\x1b[0m');
    return;
  }
  console.error('\x1b[31m[Uncaught Exception]\x1b[0m', msg);
  // For anything else, give a moment for logs to flush then exit so the
  // process can be restarted cleanly rather than hanging in a broken state
  setTimeout(() => process.exit(1), 500);
});

const WebSocket  = require('ws');
const readline   = require('readline');
const { URL }    = require('url');
const open       = require('open');
const fs         = require('fs');
const path       = require('path');
const { getCreatorHandle }                                          = require('./parser');
const { startPolling, broadcast, loadSubs }                         = require('./telegram');
const { loadWhitelist, saveWhitelist, normalise, findEntry, isWhitelisted, addHandle, tagHandle, removeHandle } = require('./whitelist');

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const c = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  gray:    '\x1b[90m',
  magenta: '\x1b[35m',
  bgGreen: '\x1b[42m\x1b[30m',
};

const CONFIG_PATH    = path.join(__dirname, 'config.json');

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { cli_enabled: true, telegram: { bot_token: '' } }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}


// ─── fetch polyfill ───────────────────────────────────────────────────────────
(async () => {
  if (typeof globalThis.fetch === 'function') return;
  try { const u = require('undici'); globalThis.fetch = u.fetch; globalThis.Headers = u.Headers; }
  catch { try { globalThis.fetch = require('node-fetch'); } catch {} }
})();

// ─── Sound ────────────────────────────────────────────────────────────────────
function playAlert() {
  process.stdout.write('\x07');
  setTimeout(() => process.stdout.write('\x07'), 180);
  setTimeout(() => process.stdout.write('\x07'), 360);
}

// ─── URI helpers ──────────────────────────────────────────────────────────────
function mapToHttpGateway(uri) {
  if (!uri || typeof uri !== 'string') return null;
  uri = uri.trim().replace(/^https?:\/\/(www\.)?ipfs\.io\/ipfs\//i, 'https://dweb.link/ipfs/');
  if (uri.startsWith('data:'))         return { type: 'data', value: uri };
  if (uri.startsWith('ipfs://'))       { let p = uri.slice(7); if (p.startsWith('ipfs/')) p = p.slice(5); return { type: 'http', value: `https://dweb.link/ipfs/${p}` }; }
  if (uri.startsWith('ipns://'))       return { type: 'http', value: `https://dweb.link/ipns/${uri.slice(7)}` };
  if (uri.startsWith('ar://') || uri.startsWith('arweave://')) return { type: 'http', value: `https://arweave.net/${uri.replace(/^ar(?:weave)?:\/\//, '')}` };
  if (uri.startsWith('/ipfs/'))        return { type: 'http', value: `https://dweb.link${uri}` };
  if (/^ipfs\/[A-Za-z0-9]/.test(uri)) return { type: 'http', value: `https://dweb.link/${uri}` };
  try { const u = new URL(uri); if (u.protocol === 'http:' || u.protocol === 'https:') return { type: 'http', value: uri }; } catch {}
  if (/^[a-zA-Z0-9_-]{43,}$/.test(uri)) return { type: 'http', value: `https://arweave.net/${uri}` };
  return { type: 'unknown', value: uri };
}

// ─── URI blocklist & failure cache ───────────────────────────────────────────
// Patterns that are guaranteed to never contain useful metadata.
const URI_BLOCKLIST = [
  'default-metadata-placeholder',
  'placeholder',
  'undefined',
  'null',
  'example.com',
  'test.com',
];

// Cache of URIs that failed recently — keyed by resolved URL, value = expiry ms.
// Entries expire after 1 hour so transient failures don't block forever.
const failedUriCache = new Map();
const FAIL_TTL = 60 * 60 * 1_000; // 1 hour

function isBlocklisted(url) {
  const lower = url.toLowerCase();
  return URI_BLOCKLIST.some(p => lower.includes(p));
}

function markFailed(url) {
  failedUriCache.set(url, Date.now() + FAIL_TTL);
}

function isCachedFail(url) {
  const expiry = failedUriCache.get(url);
  if (!expiry) return false;
  if (Date.now() > expiry) { failedUriCache.delete(url); return false; }
  return true;
}

const NETWORK_ERR_PATTERNS = ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'fetch failed', 'network'];

function isFetchRetryable(err) {
  const msg = (err?.message ?? '').toLowerCase();
  return NETWORK_ERR_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

async function fetchJsonFromUri(originalUri, opts = {}) {
  const info = mapToHttpGateway(originalUri);
  if (!info) throw new Error('Invalid URI');
  if (info.type === 'data') {
    const m = info.value.match(/^data:(.*?),(.*)$/s); if (!m) throw new Error('Bad data URI');
    const body = /;base64$/.test(m[1]) ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
    return JSON.parse(body);
  }
  if (info.type !== 'http') throw new Error(`Unsupported URI: ${originalUri}`);

  const url = info.value;

  // Fast-fail: known-bad patterns
  if (isBlocklisted(url)) throw new Error('URI is blocklisted');

  // Fast-fail: recently failed URI
  if (isCachedFail(url)) throw new Error('URI is in failure cache');

  // Network errors get long backoffs (connection lost); endpoint errors fail fast.
  // Max 3 attempts total — we won't wait 2 minutes for a dead arweave URL.
  const BACKOFFS     = [0, 3_000, 10_000];
  const NET_BACKOFFS = [0, 5_000, 15_000, 30_000, 60_000];
  const max          = 3;
  let lastErr;

  for (let a = 1; a <= max; a++) {
    const isNet  = lastErr ? isFetchRetryable(lastErr) : false;
    const waits  = isNet ? NET_BACKOFFS : BACKOFFS;
    const wait   = waits[a - 1] ?? 60_000;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6_000);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'metadata-fetcher/1' } });
      clearTimeout(t);
      if (!res.ok) {
        // 404, 410, 403 etc. — dead endpoint, don't retry, cache it
        markFailed(url);
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Not JSON'); }
    } catch (err) {
      lastErr = err;
      // Already marked failed above — rethrow immediately
      if (err.message.startsWith('HTTP ')) throw err;
      // Abort (timeout) on a non-network error = dead endpoint, cache it
      if (err.message === 'This operation was aborted' && !isFetchRetryable(err)) {
        if (a >= 2) { markFailed(url); throw err; }
      }
      if (a === max) { markFailed(url); throw err; }
      log(`${ts()} ${c.dim}[Fetch] attempt ${a}/${max} failed: ${err.message} — retrying in ${(waits[a] ?? 60_000) / 1000}s…${c.reset}`);
    }
  }
  throw lastErr;
}
function findCommunitiesUrl(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.includes('communities') ? obj : null;
  if (Array.isArray(obj))           { for (const i of obj) { const r = findCommunitiesUrl(i); if (r) return r; } }
  else if (typeof obj === 'object') { for (const v of Object.values(obj)) { const r = findCommunitiesUrl(v); if (r) return r; } }
  return null;
}

/**
 * Scan metadata for any x.com / twitter.com URL and extract the username.
 * Matches:
 *   https://x.com/GoatGems
 *   https://twitter.com/GoatGems
 *   https://x.com/GoatGems/status/123456   (tweet — username is still first segment)
 * Returns "@GoatGems" or null.
 */
function extractXHandle(obj) {
  // Regex: captures the first path segment after x.com/ or twitter.com/
  // Excludes known non-user paths: i, home, search, explore, notifications, messages
  const X_URL_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?!i\/|home|search|explore|notifications|messages)([A-Za-z0-9_]{1,50})/i;

  function scan(val) {
    if (!val) return null;
    if (typeof val === 'string') {
      const m = val.match(X_URL_RE);
      return m ? '@' + m[1] : null;
    }
    if (Array.isArray(val)) {
      for (const item of val) { const r = scan(item); if (r) return r; }
    } else if (typeof val === 'object') {
      // Prioritise the "twitter" key if it exists
      if (val.twitter) { const r = scan(val.twitter); if (r) return r; }
      for (const v of Object.values(val)) { const r = scan(v); if (r) return r; }
    }
    return null;
  }

  return scan(obj);
}

// ─── Logging (prints above the prompt cleanly) ────────────────────────────────
function log(msg) {
  clearPromptLine();
  console.log(msg);
  rl.prompt(true);
}

function ts() { return c.gray + '[' + new Date().toTimeString().slice(0, 8) + ']' + c.reset; }

// ─── UI helpers ───────────────────────────────────────────────────────────────
function clearPromptLine() {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
}

function printBanner() {
  process.stdout.write('\x1Bc');
  console.log(c.cyan + c.bold + [
    '',
    '  ████████╗ ██████╗ ██╗  ██╗███████╗███╗  ██╗',
    '     ██╔══╝██╔═══██╗██║ ██╔╝██╔════╝████╗ ██║',
    '     ██║   ██║   ██║█████╔╝ █████╗  ██╔██╗██║',
    '     ██║   ██║   ██║██╔═██╗ ██╔══╝  ██║╚████║',
    '     ██║   ╚██████╔╝██║  ██╗███████╗██║  ███║',
    '     ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚══╝',
    '',
  ].join('\n') + c.reset);
  console.log(c.dim + '  pump.fun community token monitor\n' + c.reset);
}

function printStatusLine() {
  const cfg      = loadConfig();
  const cliLabel = cfg.cli_enabled ? `${c.green}on${c.reset}` : `${c.red}off${c.reset}`;
  const tgOk     = cfg.telegram?.bot_token && cfg.telegram.bot_token !== 'YOUR_BOT_TOKEN_HERE';
  const subCount = loadSubs().size;
  const tgLabel  = tgOk
    ? `${c.green}on${c.reset} ${c.dim}(${subCount} subscriber${subCount !== 1 ? 's' : ''})${c.reset}`
    : `${c.dim}not configured${c.reset}`;
  const wlCount  = loadWhitelist().length;
  console.log(`  CLI ${cliLabel}  │  Telegram ${tgLabel}  │  Whitelist: ${wlCount} handle(s)\n`);
}

function printHelp() {
  console.log([
    `  ${c.bold}Commands${c.reset}`,
    `  ${c.cyan}add <@handle> [tag]${c.reset}        Add handle, optional name tag`,
    `  ${c.cyan}tag <@handle> <tag>${c.reset}        Set or update a handle's tag`,
    `  ${c.cyan}remove <@handle>${c.reset}           Remove handle from whitelist`,
    `  ${c.cyan}list${c.reset}                       Show current whitelist`,
    `  ${c.cyan}cli on|off${c.reset}                 Enable / disable browser tab & sound`,
    `  ${c.cyan}help${c.reset}                       Show this message`,
    `  ${c.cyan}exit${c.reset}                       Quit`,
    '',
  ].join('\n'));
}

function printWhitelist() {
  const list = loadWhitelist();
  if (list.length === 0) { console.log(`\n  ${c.dim}Whitelist is empty.${c.reset}\n`); return; }
  console.log(`\n  ${c.bold}Whitelist (${list.length})${c.reset}`);
  for (const e of list) {
    const tagStr = e.tag ? `  ${c.magenta}${e.tag}${c.reset}` : `  ${c.dim}(no tag)${c.reset}`;
    console.log(`  ${c.green}✓${c.reset}  ${e.handle}${tagStr}`);
  }
  console.log('');
}

function printAlert(mint, pairAddress, tokenName, handle, tag, axiomUrl) {
  const bar     = c.green + '━'.repeat(54) + c.reset;
  const tagLine = tag ? `  ${c.bold}Tag    ${c.reset}  ${c.magenta}${tag}${c.reset}` : null;
  console.log('\n' + bar);
  console.log(`  ${c.bgGreen}  🚀 MATCH  ${c.reset}  ${ts()}`);
  console.log(`  ${c.bold}Token  ${c.reset}  ${tokenName}`);
  console.log(`  ${c.bold}Mint   ${c.reset}  ${c.dim}${mint}${c.reset}`);
  console.log(`  ${c.bold}Handle ${c.reset}  ${c.green}${handle}${c.reset}`);
  if (tagLine) console.log(tagLine);
  console.log(`  ${c.bold}Axiom  ${c.reset}  ${c.cyan}${axiomUrl}${c.reset}`);
  console.log(bar + '\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: `${c.cyan}›${c.reset} `,
});

function handleCommand(line) {
  const parts = line.trim().split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();
  if (!cmd) { rl.prompt(); return; }

  switch (cmd) {
    case 'add': {
      const h   = parts[1];
      const tag = parts.slice(2).join(' ') || null;
      if (!h) {
        console.log(`  ${c.yellow}Usage: add <@handle> [tag]${c.reset}`);
      } else if (addHandle(h, tag)) {
        const tagStr = tag ? ` ${c.dim}→${c.reset} ${c.magenta}${tag}${c.reset}` : '';
        console.log(`  ${c.green}✓${c.reset}  Added ${h.startsWith('@') ? h : '@' + h}${tagStr}`);
      } else {
        console.log(`  ${c.dim}Already in whitelist. Use ${c.reset}tag ${h} <name>${c.dim} to set a tag.${c.reset}`);
      }
      break;
    }
    case 'tag': {
      const h   = parts[1];
      const tag = parts.slice(2).join(' ');
      if (!h || !tag) {
        console.log(`  ${c.yellow}Usage: tag <@handle> <tag>${c.reset}`);
      } else if (tagHandle(h, tag)) {
        console.log(`  ${c.green}✓${c.reset}  Tag set: ${c.magenta}${tag}${c.reset} → ${h}`);
      } else {
        console.log(`  ${c.dim}Handle not found in whitelist.${c.reset}`);
      }
      break;
    }
    case 'remove': case 'rm': {
      const h = parts[1];
      if (!h) console.log(`  ${c.yellow}Usage: remove <@handle>${c.reset}`);
      else if (removeHandle(h)) console.log(`  ${c.red}✗${c.reset}  Removed ${h}`);
      else console.log(`  ${c.dim}Handle not found.${c.reset}`);
      break;
    }
    case 'list': case 'ls':
      printWhitelist(); break;
    case 'cli': {
      const arg = parts[1]?.toLowerCase();
      if (arg !== 'on' && arg !== 'off') {
        console.log(`  ${c.yellow}Usage: cli on|off${c.reset}`);
      } else {
        const cfg = loadConfig();
        cfg.cli_enabled = arg === 'on';
        saveConfig(cfg);
        console.log(`  CLI ${cfg.cli_enabled ? `${c.green}enabled${c.reset}` : `${c.red}disabled${c.reset}`}`);
      }
      break;
    }
    case 'help':   printHelp(); break;
    case 'exit': case 'quit':
      console.log(`\n  ${c.dim}Goodbye.${c.reset}\n`);
      process.exit(0);
      break;
    default:
      console.log(`  ${c.dim}Unknown command — type ${c.reset}help${c.dim} for options.${c.reset}`);
  }

  rl.prompt();
}

// ─── Token processing queue ───────────────────────────────────────────────────
// Tokens arrive faster than they can be processed (30/min, ~5s per scrape).
// A simple queue ensures every token is processed in order, one at a time,
// so Puppeteer never runs in parallel and nothing gets silently dropped.

const tokenQueue   = [];
let   queueRunning = false;

function enqueue(event) {
  tokenQueue.push(event);
  if (tokenQueue.length > 1) {
    log(`${ts()} ${c.gray}[Queue] depth: ${tokenQueue.length}${c.reset}`);
  }
  if (!queueRunning) drainQueue();
}

async function drainQueue() {
  if (queueRunning) return; // guard against double-start
  queueRunning = true;
  try {
    while (tokenQueue.length > 0) {
      const event = tokenQueue.shift();
      try {
        await processToken(event);
      } catch (err) {
        log(`${ts()} ${c.red}[Queue] Token processing error: ${err?.message ?? err}${c.reset}`);
      }
    }
  } catch (err) {
    log(`${ts()} ${c.red}[Queue] drainQueue crashed: ${err?.message ?? err}${c.reset}`);
  } finally {
    // Always release the lock — even if something unexpected throws
    queueRunning = false;
    // If items arrived while we were in the finally block, restart
    if (tokenQueue.length > 0) drainQueue();
  }
}

async function processToken(event) {
  const { uri, name, mint, bondingCurveKey } = event;
  if (!uri) return;

  // Fast-fail before even logging — no point showing tokens we'll immediately skip
  const resolvedInfo = mapToHttpGateway(uri);
  const resolvedUrl  = resolvedInfo?.value ?? uri;
  if (isBlocklisted(resolvedUrl) || isCachedFail(resolvedUrl)) return;

  log(`${ts()} ${c.cyan}[Token]${c.reset} ${name ?? 'Unknown'}  ${c.dim}${mint}${c.reset}`);
  log(`${ts()} ${c.dim}        URI: ${uri}${c.reset}`);

  let meta;
  try {
    meta = await fetchJsonFromUri(uri);
  } catch (err) {
    log(`${ts()} ${c.dim}        [Skip] Could not fetch URI — ${err.message}${c.reset}`);
    return;
  }

  // ── Check 1: community page → scrape handle via Puppeteer ──────────────────
  const communityUrl = findCommunitiesUrl(meta);

  // ── Check 2: twitter field contains a plain x.com profile or tweet URL ──
  // Extract the username directly from the URL — no scraping needed.
  // Handles:  https://x.com/GoatGems
  //           https://twitter.com/GoatGems
  //           https://x.com/GoatGems/status/123456
  const twitterHandle = extractXHandle(meta);

  if (!communityUrl && !twitterHandle) {
    log(`${ts()} ${c.dim}        [Skip] No community URL or Twitter handle in metadata${c.reset}`);
    return;
  }

  const whitelist = loadWhitelist();
  let entry  = null;
  let handle = null;
  let matchSource = '';

  // ── Twitter/X direct URL — checked first, no scraping needed ─────────────
  if (twitterHandle) {
    log(`${ts()} ${c.yellow}        [Twitter]${c.reset} Handle from URL: ${twitterHandle}`);
    const found = findEntry(twitterHandle, whitelist);
    if (found) { entry = found; handle = twitterHandle; matchSource = 'twitter'; }
    else log(`${ts()} ${c.dim}        [Twitter] ${twitterHandle} not in whitelist${c.reset}`);
  }

  // ── Community path — only scrape if twitter check didn't already match ────
  if (!entry && communityUrl) {
    log(`${ts()} ${c.yellow}        [Community]${c.reset} ${communityUrl}`);
    log(`${ts()} ${c.dim}        [Parser] Scraping handle…${c.reset}`);

    let scraped;
    try {
      scraped = await getCreatorHandle(communityUrl);
    } catch (err) {
      const netErr = err?.message?.includes('ERR_NAME_NOT_RESOLVED') || err?.message?.includes('net::');
      const hint   = netErr ? ' (network - all retries exhausted)' : '';
      log(`${ts()} ${c.red}        [Parser] Failed${c.reset}${c.dim}${hint}: ${err.message}${c.reset}`);
    }

    if (scraped) {
      log(`${ts()} ${c.dim}        [Parser] Handle: ${c.reset}${scraped}`);
      const found = findEntry(scraped, whitelist);
      if (found) { entry = found; handle = scraped; matchSource = 'community'; }
      else log(`${ts()} ${c.dim}        [Community] ${scraped} not in whitelist${c.reset}`);
    } else {
      log(`${ts()} ${c.dim}        [Parser] No handle found${c.reset}`);
    }
  }

  if (!entry) {
    log(`${ts()} ${c.dim}        [Skip] No whitelisted handle found${c.reset}`);
    return;
  }

  log(`${ts()} ${c.green}        [Match]${c.reset} ${handle} via ${matchSource}`);

  const tag         = entry.tag ?? null;
  const pairAddress = bondingCurveKey ?? mint;
  const axiomUrl    = `https://axiom.trade/meme/${pairAddress}?chain=sol`;
  const cfg         = loadConfig();

  // 1. CLI: sound + alert + open tab
  if (cfg.cli_enabled) {
    clearPromptLine();
    playAlert();
    printAlert(mint, pairAddress, name ?? 'Unknown', handle, tag, axiomUrl);
    rl.prompt(true);
    await open(axiomUrl).catch(() => {});
  }

  // 2. Telegram broadcast
  const token = cfg.telegram?.bot_token;
  if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    log(`${ts()} ${c.dim}        [Telegram] Broadcasting to ${loadSubs().size} subscriber(s)…${c.reset}`);
    await broadcast(token, name ?? 'Unknown', mint, handle, tag, axiomUrl);
    log(`${ts()} ${c.dim}        [Telegram] Sent${c.reset}`);
  }
}

// ─── WebSocket monitor ────────────────────────────────────────────────────────
function startMonitor() {
  let dead = false; // prevents double-reconnect

  function kill(reason) {
    if (dead) return;
    dead = true;
    log(`${ts()} ${c.yellow}[WS]${c.reset} ${reason} — reconnecting in 3s…`);
    try { ws.terminate(); } catch { /* ignore */ }
    setTimeout(startMonitor, 3_000);
  }

  const ws = new WebSocket('wss://pumpportal.fun/api/data');

  // Zombie-connection watchdog: if we go 45s without any message, assume
  // the connection is stale and force a reconnect.
  let lastMsgAt = Date.now();
  const watchdog = setInterval(() => {
    const silentMs = Date.now() - lastMsgAt;
    if (silentMs > 45_000) {
      log(`${ts()} ${c.yellow}[WS]${c.reset} No data for ${Math.round(silentMs / 1000)}s — forcing reconnect`);
      clearInterval(watchdog);
      kill('Watchdog timeout');
    }
  }, 10_000);

  ws.on('open', () => {
    lastMsgAt = Date.now();
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    log(`${ts()} ${c.green}[WS]${c.reset} Connected — subscribed to new tokens`);
  });

  ws.on('message', (data) => {
    lastMsgAt = Date.now();
    let event;
    try { event = JSON.parse(data); } catch {
      log(`${ts()} ${c.red}[WS]${c.reset} Failed to parse message`);
      return;
    }
    enqueue(event);
  });

  ws.on('error', (err) => {
    log(`${ts()} ${c.red}[WS Error]${c.reset} ${err?.message ?? err}`);
    clearInterval(watchdog);
    kill('WebSocket error');
  });

  ws.on('close', (code, reason) => {
    clearInterval(watchdog);
    const why = reason?.toString() || 'no reason given';
    kill(`Closed (code ${code}: ${why})`);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
printBanner();
if (!fs.existsSync(CONFIG_PATH))    saveConfig(loadConfig());

const { bot_token } = loadConfig().telegram ?? {};
startPolling(bot_token);

printStatusLine();
printHelp();

startMonitor();
rl.prompt();
rl.on('line', handleCommand);
rl.on('close', () => process.exit(0));