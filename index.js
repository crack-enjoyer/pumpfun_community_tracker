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
const { getCreatorHandle }                   = require('./parser');
const { startPolling, broadcast, loadSubs }  = require('./telegram');

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

const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');
const CONFIG_PATH    = path.join(__dirname, 'config.json');

// ─── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { cli_enabled: true, telegram: { bot_token: '' } }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── Whitelist ────────────────────────────────────────────────────────────────
function loadWhitelist() {
  try {
    const raw = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
    return raw.map(entry =>
      typeof entry === 'string'
        ? { handle: entry, tag: null }
        : { handle: entry.handle, tag: entry.tag ?? null }
    );
  } catch { return []; }
}

function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

function normalise(h) { return h.replace(/^@/, '').toLowerCase(); }

function findEntry(handle, list) {
  return list.find(e => normalise(e.handle) === normalise(handle)) ?? null;
}

function isWhitelisted(handle, list) { return !!findEntry(handle, list); }

function addHandle(handle, tag = null) {
  const list = loadWhitelist();
  if (findEntry(handle, list)) return false;
  list.push({ handle: handle.startsWith('@') ? handle : '@' + handle, tag });
  saveWhitelist(list);
  return true;
}

function tagHandle(handle, tag) {
  const list  = loadWhitelist();
  const entry = findEntry(handle, list);
  if (!entry) return false;
  entry.tag = tag || null;
  saveWhitelist(list);
  return true;
}

function removeHandle(handle) {
  const list = loadWhitelist();
  const next = list.filter(e => normalise(e.handle) !== normalise(handle));
  if (next.length === list.length) return false;
  saveWhitelist(next);
  return true;
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

const NETWORK_ERR_PATTERNS = ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'fetch failed', 'network', 'abort'];

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

  const url      = info.value;
  const BACKOFFS = [0, 5_000, 15_000, 30_000, 60_000];
  const max      = 5;
  let lastErr;

  for (let a = 1; a <= max; a++) {
    const wait = BACKOFFS[a - 1] ?? 60_000;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'metadata-fetcher/1' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Not JSON'); }
    } catch (err) {
      lastErr = err;
      const retryable = isFetchRetryable(err);
      if (!retryable && a >= 2) throw err;
      if (a === max) throw err;
      log(`${ts()} ${c.dim}[Fetch] attempt ${a}/${max} failed: ${err.message} - retrying in ${BACKOFFS[a] / 1000}s...${c.reset}`);
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

// ─── WebSocket monitor ────────────────────────────────────────────────────────
function startMonitor() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    log(`${ts()} ${c.green}[WS]${c.reset} Connected — subscribed to new tokens`);
  });

  ws.on('message', async (data) => {
    let event;
    try { event = JSON.parse(data); } catch {
      log(`${ts()} ${c.red}[WS]${c.reset} Failed to parse message`);
      return;
    }

    const { uri, name, mint, bondingCurveKey } = event;
    if (!uri) return;

    log(`${ts()} ${c.cyan}[Token]${c.reset} ${name ?? 'Unknown'}  ${c.dim}${mint}${c.reset}`);
    log(`${ts()} ${c.dim}        URI: ${uri}${c.reset}`);

    let meta;
    try {
      meta = await fetchJsonFromUri(uri);
    } catch (err) {
      log(`${ts()} ${c.dim}        [Skip] Could not fetch URI — ${err.message}${c.reset}`);
      return;
    }

    const twitterHandle = extractXHandle(meta);
    let communityUrl = null;

    if (!twitterHandle) {
      communityUrl = findCommunitiesUrl(meta);
    }

    if (!communityUrl && !twitterHandle) {
      log(`${ts()} ${c.dim}        [Skip] No community URL or Twitter handle in metadata${c.reset}`);
      return;
    }

    const whitelist = loadWhitelist();
    let entry  = null;
    let handle = null;
    let matchSource = '';

    // ── Community path ────────────────────────────────────────────────────────
    if (communityUrl) {
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
      } else if (!twitterHandle) {
        log(`${ts()} ${c.dim}        [Parser] No handle found${c.reset}`);
      }
    }

    // ── Twitter/X direct URL path (only if community didn't already match) ───
    if (!entry && twitterHandle) {
      log(`${ts()} ${c.yellow}        [Twitter]${c.reset} Handle from URL: ${twitterHandle}`);
      const found = findEntry(twitterHandle, whitelist);
      if (found) { entry = found; handle = twitterHandle; matchSource = 'twitter'; }
      else log(`${ts()} ${c.dim}        [Twitter] ${twitterHandle} not in whitelist${c.reset}`);
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
  });

  ws.on('error', (err) => {
    log(`${ts()} ${c.red}[WS Error]${c.reset} ${err?.message ?? err}`);
  });

  ws.on('close', () => {
    log(`${ts()} ${c.yellow}[WS]${c.reset} Disconnected — reconnecting in 3s…`);
    setTimeout(startMonitor, 3_000);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
printBanner();
if (!fs.existsSync(WHITELIST_PATH)) saveWhitelist([]);
if (!fs.existsSync(CONFIG_PATH))    saveConfig(loadConfig());

const { bot_token } = loadConfig().telegram ?? {};
startPolling(bot_token);

printStatusLine();
printHelp();

startMonitor();
rl.prompt();
rl.on('line', handleCommand);
rl.on('close', () => process.exit(0));