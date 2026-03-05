// filename: index.js
'use strict';

const WebSocket  = require('ws');
const readline   = require('readline');
const { URL }    = require('url');
const open       = require('open');
const fs         = require('fs');
const path       = require('path');
const { getCreatorHandle }       = require('./parser');
const { startPolling, broadcast, loadSubs } = require('./telegram');

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
  try { return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8')); }
  catch { return []; }
}

function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

function normalise(h) { return h.replace(/^@/, '').toLowerCase(); }
function isWhitelisted(handle, list) { return list.some(h => normalise(h) === normalise(handle)); }

function addHandle(handle) {
  const list = loadWhitelist();
  if (list.some(h => normalise(h) === normalise(handle))) return false;
  list.push(handle.startsWith('@') ? handle : '@' + handle);
  saveWhitelist(list);
  return true;
}

function removeHandle(handle) {
  const list = loadWhitelist();
  const next = list.filter(h => normalise(h) !== normalise(handle));
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

async function fetchJsonFromUri(originalUri, opts = {}) {
  const info = mapToHttpGateway(originalUri);
  if (!info) throw new Error('Invalid URI');
  if (info.type === 'data') {
    const m = info.value.match(/^data:(.*?),(.*)$/s); if (!m) throw new Error('Bad data URI');
    const body = /;base64$/.test(m[1]) ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
    return JSON.parse(body);
  }
  if (info.type !== 'http') throw new Error(`Unsupported URI: ${originalUri}`);
  const url = info.value, max = opts.retries ?? 2;
  for (let a = 1; a <= max; a++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'metadata-fetcher/1' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Not JSON'); }
    } catch (err) {
      if (a === max) throw err;
      await new Promise(r => setTimeout(r, 300 * a));
    }
  }
}

function findCommunitiesUrl(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.includes('communities') ? obj : null;
  if (Array.isArray(obj))           { for (const i of obj) { const r = findCommunitiesUrl(i); if (r) return r; } }
  else if (typeof obj === 'object') { for (const v of Object.values(obj)) { const r = findCommunitiesUrl(v); if (r) return r; } }
  return null;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function ts() { return c.gray + new Date().toTimeString().slice(0, 8) + c.reset; }

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
    `  ${c.cyan}add <@handle>${c.reset}       Add handle to whitelist`,
    `  ${c.cyan}remove <@handle>${c.reset}    Remove handle from whitelist`,
    `  ${c.cyan}list${c.reset}                Show current whitelist`,
    `  ${c.cyan}cli on|off${c.reset}          Enable / disable browser tab opening & sound`,
    `  ${c.cyan}help${c.reset}                Show this message`,
    `  ${c.cyan}exit${c.reset}                Quit`,
    '',
  ].join('\n'));
}

function printWhitelist() {
  const list = loadWhitelist();
  if (list.length === 0) { console.log(`\n  ${c.dim}Whitelist is empty.${c.reset}\n`); return; }
  console.log(`\n  ${c.bold}Whitelist (${list.length})${c.reset}`);
  list.forEach(h => console.log(`  ${c.green}✓${c.reset}  ${h}`));
  console.log('');
}

function printAlert(mint, pairAddress, tokenName, handle, axiomUrl) {
  const bar = c.green + '━'.repeat(54) + c.reset;
  console.log('\n' + bar);
  console.log(`  ${c.bgGreen}  🚀 MATCH  ${c.reset}  ${ts()}`);
  console.log(`  ${c.bold}Token  ${c.reset}  ${tokenName}`);
  console.log(`  ${c.bold}Mint   ${c.reset}  ${c.dim}${mint}${c.reset}`);
  console.log(`  ${c.bold}Handle ${c.reset}  ${c.green}${handle}${c.reset}`);
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
      const h = parts[1];
      if (!h) console.log(`  ${c.yellow}Usage: add <@handle>${c.reset}`);
      else if (addHandle(h)) console.log(`  ${c.green}✓${c.reset}  Added ${h.startsWith('@') ? h : '@' + h}`);
      else console.log(`  ${c.dim}Already in whitelist.${c.reset}`);
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

  ws.on('open', () => ws.send(JSON.stringify({ method: 'subscribeNewToken' })));

  ws.on('message', async (data) => {
    let event;
    try { event = JSON.parse(data); } catch { return; }

    const { uri, name, mint, bondingCurveKey } = event;
    if (!uri) return;

    let meta;
    try { meta = await fetchJsonFromUri(uri); } catch { return; }

    const communityUrl = findCommunitiesUrl(meta);
    if (!communityUrl) return;

    let handle;
    try { handle = await getCreatorHandle(communityUrl); } catch { return; }
    if (!handle) return;

    const whitelist = loadWhitelist();
    if (!isWhitelisted(handle, whitelist)) return;

    const pairAddress = bondingCurveKey ?? mint;
    const axiomUrl    = `https://axiom.trade/meme/${pairAddress}?chain=sol`;
    const cfg         = loadConfig();

    // 1. CLI: sound + alert box + open tab
    if (cfg.cli_enabled) {
      clearPromptLine();
      playAlert();
      printAlert(mint, pairAddress, name ?? 'Unknown', handle, axiomUrl);
      rl.prompt(true);
      await open(axiomUrl).catch(() => {});
    }

    // 2. Telegram: broadcast to all subscribers
    const token = cfg.telegram?.bot_token;
    await broadcast(token, name ?? 'Unknown', mint, handle, axiomUrl);
  });

  ws.on('error', () => {});
  ws.on('close', () => setTimeout(startMonitor, 3_000));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
printBanner();
if (!fs.existsSync(WHITELIST_PATH)) saveWhitelist([]);
if (!fs.existsSync(CONFIG_PATH))    saveConfig(loadConfig());

const { bot_token } = loadConfig().telegram ?? {};
startPolling(bot_token); // background long-poll loop — never awaited

printStatusLine();
printHelp();

startMonitor();
rl.prompt();
rl.on('line', handleCommand);
rl.on('close', () => process.exit(0));