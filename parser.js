// filename: parser.js
'use strict';

const puppeteer = require('puppeteer');

// Errors that are worth retrying (network blips, DNS failure, connection reset)
const RETRYABLE = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'net::',          // catch-all for any net:: prefix
  'Navigation timeout',
];

function isRetryable(err) {
  const msg = err?.message ?? '';
  return RETRYABLE.some(pattern => msg.includes(pattern));
}

async function safeBrowserClose(browser) {
  try {
    await browser.close();
  } catch (err) {
    if (err?.code !== 'EBUSY') throw err;
  }
}

async function scrapeHandle(aboutUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
    ],
  });

  try {
    const page = await browser.newPage();

    if (typeof page.waitForTimeout !== 'function') {
      page.waitForTimeout = (ms) => new Promise(r => setTimeout(r, ms));
    }

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/115.0 Safari/537.36'
    );

    await page.goto(aboutUrl, {
      waitUntil: 'domcontentloaded',
      timeout:   30_000,
    });

    await page.waitForSelector('span', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1_200);

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
    await safeBrowserClose(browser);
  }
}

/**
 * Scrape the creator @handle from a community URL.
 * Retries on network errors with exponential backoff (up to ~2 minutes total).
 *
 * Retry schedule:
 *   attempt 1 — immediate
 *   attempt 2 — wait 5s   (connection just dropped)
 *   attempt 3 — wait 15s
 *   attempt 4 — wait 30s
 *   attempt 5 — wait 60s  (give internet time to recover)
 *
 * Non-network errors (e.g. page structure changed) fail fast after 2 attempts.
 */
async function getCreatorHandle(url, maxAttempts = 5) {
  const aboutUrl = url.endsWith('/about')
    ? url
    : url.replace(/\/+$/, '') + '/about';

  const BACKOFFS = [0, 5_000, 15_000, 30_000, 60_000];

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = BACKOFFS[attempt - 1] ?? 60_000;
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }

    try {
      const handle = await scrapeHandle(aboutUrl);
      return handle;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);

      // Non-network errors: only try twice, then give up
      if (!retryable && attempt >= 2) throw err;

      // Network error on last attempt: give up
      if (attempt === maxAttempts) throw err;

      // Otherwise loop and retry
    }
  }

  throw lastErr;
}

module.exports = { getCreatorHandle };