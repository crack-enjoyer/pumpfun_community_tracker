// filename: parser.js
// Scrapes the Twitter/X handle from a community /about page.
// Exports getCreatorHandle(url) -> string | null

const puppeteer = require('puppeteer');

/**
 * Given a Twitter/X community URL, returns the creator's handle (e.g. "@username")
 * or null if it could not be found.
 *
 * @param {string} url  Community URL, e.g. "https://x.com/i/communities/123456"
 * @returns {Promise<string|null>}
 */
async function getCreatorHandle(url) {
  const aboutUrl = url.endsWith('/about')
    ? url
    : url.replace(/\/+$/, '') + '/about';

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Polyfill for older Puppeteer versions
    if (typeof page.waitForTimeout !== 'function') {
      page.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, ms));
    }

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/115.0 Safari/537.36'
    );

    await page
      .goto(aboutUrl, { waitUntil: 'networkidle2', timeout: 30_000 })
      .catch((err) => {
        console.warn('[Parser] goto warning:', err?.message ?? err);
      });

    await page.waitForSelector('span', { timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(800);

    const handle = await page.evaluate(() => {
      // Look for a span whose text is exactly an @handle
      const spans = Array.from(document.querySelectorAll('span'));
      for (const s of spans) {
        const txt = s.textContent?.trim();
        if (txt && /^@[A-Za-z0-9_.]+$/.test(txt)) return txt;
      }
      // Fallback: CSS-class spans
      const cssSpans = Array.from(document.querySelectorAll('span[class*="css-"]'));
      for (const s of cssSpans) {
        const txt = s.textContent?.trim();
        if (txt && txt.startsWith('@') && txt.length <= 50) return txt;
      }
      return null;
    });

    return handle ?? null;
  } finally {
    await browser.close();
  }
}

module.exports = { getCreatorHandle };