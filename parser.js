// filename: parser.js
'use strict';

const puppeteer = require('puppeteer');

// ─── Persistent browser singleton ────────────────────────────────────────────
// One browser process lives for the lifetime of the program.
// Each scrape opens a new page, uses it, then closes it.
// This avoids the Windows orphan-Chrome accumulation that causes slowdowns
// and event-loop starvation after extended runtime.

let browserInstance  = null;
let browserHealthy   = true;  // set false if the browser crashes
let launchInProgress = false;
let launchWaiters    = [];     // promises waiting for the browser to be ready

async function getBrowser() {
  // Already up and healthy
  if (browserInstance && browserHealthy) return browserInstance;

  // Another call is already launching — wait for it
  if (launchInProgress) {
    return new Promise((resolve, reject) => launchWaiters.push({ resolve, reject }));
  }

  launchInProgress = true;
  browserHealthy   = true;

  try {
    // Kill any previous stale instance silently
    if (browserInstance) {
      try { await browserInstance.close(); } catch { /* ignore */ }
      browserInstance = null;
    }

    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
      ],
    });

    // If Chrome crashes or exits unexpectedly, mark unhealthy so next
    // call to getBrowser() triggers a fresh launch
    browserInstance.on('disconnected', () => {
      browserHealthy   = false;
      browserInstance  = null;
    });

    // Resolve all waiters
    const waiters = launchWaiters.splice(0);
    for (const w of waiters) w.resolve(browserInstance);

    return browserInstance;
  } catch (err) {
    browserHealthy = false;
    const waiters  = launchWaiters.splice(0);
    for (const w of waiters) w.reject(err);
    throw err;
  } finally {
    launchInProgress = false;
  }
}

// ─── Periodic health check ────────────────────────────────────────────────────
// Every 30 minutes, recycle the browser proactively to prevent slow memory
// growth from accumulating across a long session.
const RECYCLE_INTERVAL = 30 * 60 * 1_000;
setInterval(async () => {
  if (!browserInstance) return;
  try {
    // Only recycle if no scrape is actively running (pages open = 1 means
    // just the default blank page, i.e. idle)
    const pages = await browserInstance.pages();
    if (pages.length <= 1) {
      browserHealthy  = false;
      browserInstance = null;
      // getBrowser() will launch a fresh one on next scrape
    }
  } catch { /* ignore */ }
}, RECYCLE_INTERVAL).unref(); // .unref() so this timer doesn't block process exit

// ─── Single scrape attempt ────────────────────────────────────────────────────
async function scrapeHandle(aboutUrl) {
  const browser = await getBrowser();
  const page    = await browser.newPage();

  try {
    if (typeof page.waitForTimeout !== 'function') {
      page.waitForTimeout = (ms) => new Promise(r => setTimeout(r, ms));
    }

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/115.0 Safari/537.36'
    );

    // Disable images, fonts, and media — faster load, less RAM per page
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(aboutUrl, {
      waitUntil: 'domcontentloaded',
      timeout:   30_000,
    });

    // Wait for a span to exist, then let JS settle
    await page.waitForSelector('span', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    return await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      for (const s of spans) {
        const txt = s.textContent?.trim();
        if (txt && /^@[A-Za-z0-9_.]+$/.test(txt)) return txt;
      }
      const cssSpans = Array.from(document.querySelectorAll('span[class*="css-"]'));
      for (const s of cssSpans) {
        const txt = s.textContent?.trim();
        if (txt && txt.startsWith('@') && txt.length <= 50) return txt;
      }
      return null;
    });
  } finally {
    // Always close the page — never the browser
    try { await page.close(); } catch { /* ignore */ }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
const RETRYABLE_MSGS = [
  'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',  'ERR_CONNECTION_REFUSED',    'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',         'Navigation timeout',        'net::',
  'Target closed',         'Session closed',            'Protocol error',
];

function isRetryable(err) {
  const msg = err?.message ?? '';
  return RETRYABLE_MSGS.some(p => msg.includes(p));
}

/**
 * Scrape the creator @handle from a community URL.
 * Retry schedule: immediate → 5s → 15s → 30s → 60s
 */
async function getCreatorHandle(url, maxAttempts = 5) {
  const aboutUrl = url.endsWith('/about')
    ? url
    : url.replace(/\/+$/, '') + '/about';

  const BACKOFFS = [0, 5_000, 15_000, 30_000, 60_000];
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = BACKOFFS[attempt - 1] ?? 60_000;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    try {
      return await scrapeHandle(aboutUrl);
    } catch (err) {
      lastErr = err;

      // If the browser disconnected mid-scrape, mark it so getBrowser()
      // relaunches on the next attempt
      if (err?.message?.includes('Target closed') ||
          err?.message?.includes('Session closed') ||
          err?.message?.includes('Protocol error')) {
        browserHealthy  = false;
        browserInstance = null;
      }

      const retryable = isRetryable(err);
      if (!retryable && attempt >= 2) throw err;
      if (attempt === maxAttempts) throw err;
    }
  }

  throw lastErr;
}

// Pre-warm the browser at startup so the first scrape isn't slow
getBrowser().catch(() => { /* will retry on first scrape */ });

module.exports = { getCreatorHandle };