// filename: telegram.js
'use strict';

const fs   = require('fs');
const path = require('path');

const SUBS_PATH = path.join(__dirname, 'subscribers.json');

// ─── Subscriber persistence ───────────────────────────────────────────────────
function loadSubs() {
  try { return new Set(JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'))); }
  catch { return new Set(); }
}

function saveSubs(set) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify([...set], null, 2));
}

// ─── Telegram API wrapper ─────────────────────────────────────────────────────
async function tgCall(token, method, body = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    return await res.json();
  } catch { return null; }
}

// ─── Long-polling loop ────────────────────────────────────────────────────────
async function startPolling(token) {
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') return;

  let offset = 0;

  while (true) {
    const data = await tgCall(token, 'getUpdates', {
      offset,
      timeout:         25,
      allowed_updates: ['message'],
    });

    if (!data || !data.ok || !Array.isArray(data.result)) {
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    for (const update of data.result) {
      offset = update.update_id + 1;

      const msg  = update.message;
      const text = msg?.text?.trim();
      const id   = String(msg?.chat?.id ?? '');
      const name = msg?.chat?.first_name ?? msg?.chat?.username ?? 'there';

      if (!text || !id) continue;

      const subs = loadSubs();

      if (text.startsWith('/start')) {
        if (!subs.has(id)) {
          subs.add(id);
          saveSubs(subs);
          await tgCall(token, 'sendMessage', {
            chat_id:    id,
            text:       `👋 Hey ${name}! You're now subscribed to token alerts.\n\nSend /stop at any time to unsubscribe.`,
            parse_mode: 'HTML',
          });
        } else {
          await tgCall(token, 'sendMessage', {
            chat_id:    id,
            text:       `✅ You're already subscribed. Send /stop to unsubscribe.`,
            parse_mode: 'HTML',
          });
        }
      } else if (text.startsWith('/stop')) {
        if (subs.has(id)) {
          subs.delete(id);
          saveSubs(subs);
          await tgCall(token, 'sendMessage', {
            chat_id:    id,
            text:       `👋 You've been unsubscribed. Send /start to resubscribe anytime.`,
            parse_mode: 'HTML',
          });
        } else {
          await tgCall(token, 'sendMessage', {
            chat_id:    id,
            text:       `You're not currently subscribed. Send /start to subscribe.`,
            parse_mode: 'HTML',
          });
        }
      }
    }
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
async function broadcast(token, tokenName, mint, handle, tag, axiomUrl) {
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') return;

  const subs = loadSubs();
  if (subs.size === 0) return;

  const tagLine = tag ? `<b>Tag:</b>    🏷 ${tag}\n` : '';

  const text = [
    `🚀 <b>Token Match</b>`,
    ``,
    `<b>Token:</b>  ${tokenName}`,
    `<b>Handle:</b> ${handle}`,
    `${tagLine}<b>Mint:</b>   <code>${mint}</code>`,
    ``,
    `<a href="${axiomUrl}">📈 Open on Axiom</a>`,
  ].join('\n');

  await Promise.allSettled(
    [...subs].map(id =>
      tgCall(token, 'sendMessage', {
        chat_id:                  id,
        text,
        parse_mode:               'HTML',
        disable_web_page_preview: false,
      })
    )
  );
}

module.exports = { startPolling, broadcast, loadSubs };