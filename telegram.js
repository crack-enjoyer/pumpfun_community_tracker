// filename: telegram.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { loadWhitelist, addHandle, tagHandle, removeHandle } = require('./whitelist');

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

async function reply(token, chatId, text) {
  return tgCall(token, 'sendMessage', {
    chat_id:                  chatId,
    text,
    parse_mode:               'HTML',
    disable_web_page_preview: true,
  });
}

// ─── Command handlers ─────────────────────────────────────────────────────────
function handleHelp() {
  return [
    '<b>Token Monitor Bot</b>',
    '',
    '/start            — subscribe to alerts',
    '/stop             — unsubscribe',
    '/wl_add @handle [tag]  — add handle to whitelist',
    '/wl_remove @handle     — remove handle',
    '/wl_tag @handle [tag]  — set or clear a tag (omit tag to clear)',
    '/wl_list               — show full whitelist',
    '/help             — show this message',
  ].join('\n');
}

function handleWlList() {
  const list = loadWhitelist();
  if (list.length === 0) return '📋 Whitelist is empty.';
  const lines = list.map((e, i) => {
    const tag = e.tag ? `  🏷 <i>${e.tag}</i>` : '';
    return `${i + 1}. <code>${e.handle}</code>${tag}`;
  });
  return `📋 <b>Whitelist (${list.length})</b>\n\n` + lines.join('\n');
}

function handleWlAdd(parts) {
  const handle = parts[1];
  if (!handle) return '⚠️ Usage: /wl_add @handle [tag]';
  const tag  = parts.slice(2).join(' ') || null;
  const ok   = addHandle(handle, tag);
  if (!ok) return `⚠️ <code>${handle}</code> is already in the whitelist.\nUse /wl_tag to update its tag.`;
  const h      = handle.startsWith('@') ? handle : '@' + handle;
  const tagStr = tag ? `  🏷 <i>${tag}</i>` : '';
  return `✅ Added <code>${h}</code>${tagStr}`;
}

function handleWlRemove(parts) {
  const handle = parts[1];
  if (!handle) return '⚠️ Usage: /wl_remove @handle';
  const ok = removeHandle(handle);
  return ok
    ? `🗑 Removed <code>${handle}</code>`
    : `⚠️ <code>${handle}</code> not found in whitelist.`;
}

function handleWlTag(parts) {
  const handle = parts[1];
  if (!handle) return '⚠️ Usage: /wl_tag @handle [tag]';
  const tag = parts.slice(2).join(' ') || null;
  const ok  = tagHandle(handle, tag);
  if (!ok) return `⚠️ <code>${handle}</code> not found in whitelist.`;
  return tag
    ? `🏷 Tag updated: <code>${handle}</code> → <i>${tag}</i>`
    : `🏷 Tag cleared for <code>${handle}</code>`;
}

// ─── Long-polling loop ────────────────────────────────────────────────────────
async function startPolling(token) {
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') return;

  let offset         = 0;
  let backoff        = 5_000;
  let consecutiveFails = 0;

  while (true) {
    let data;
    try {
      data = await tgCall(token, 'getUpdates', {
        offset,
        timeout:         25,
        allowed_updates: ['message'],
      });
    } catch (err) {
      consecutiveFails++;
      const wait = Math.min(backoff * consecutiveFails, 60_000);
      console.warn(`\x1b[90m[TG Poll] Network error (${consecutiveFails}x): ${err?.message ?? err} — retrying in ${wait / 1000}s\x1b[0m`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!data || !data.ok || !Array.isArray(data.result)) {
      consecutiveFails++;
      const wait = Math.min(backoff * consecutiveFails, 60_000);
      const reason = data?.description ?? 'bad response';
      console.warn(`\x1b[90m[TG Poll] Bad response (${consecutiveFails}x): ${reason} — retrying in ${wait / 1000}s\x1b[0m`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    // Successful poll — reset failure counter
    consecutiveFails = 0;

    for (const update of data.result) {
      offset = update.update_id + 1;

      const msg      = update.message;
      const text     = msg?.text?.trim();
      const chatId   = String(msg?.chat?.id ?? '');
      const userName = msg?.chat?.first_name ?? msg?.chat?.username ?? 'there';

      if (!text || !chatId) continue;

      // Wrap each command handler so one bad message can't kill the loop
      try {
        const subs  = loadSubs();
        const parts = text.split(/\s+/);
        const cmd   = (parts[0] ?? '').replace(/@\S+$/, '').toLowerCase();

        switch (cmd) {
          case '/start':
            if (!subs.has(chatId)) {
              subs.add(chatId);
              saveSubs(subs);
              await reply(token, chatId,
                `👋 Hey ${userName}! You're now subscribed to token alerts.\n\nSend /stop to unsubscribe or /help to see all commands.`
              );
            } else {
              await reply(token, chatId, `✅ You're already subscribed. Send /stop to unsubscribe.`);
            }
            break;

          case '/stop':
            if (subs.has(chatId)) {
              subs.delete(chatId);
              saveSubs(subs);
              await reply(token, chatId, `👋 Unsubscribed. Send /start to resubscribe anytime.`);
            } else {
              await reply(token, chatId, `You're not subscribed. Send /start to subscribe.`);
            }
            break;

          case '/help':
            await reply(token, chatId, handleHelp());
            break;

          case '/wl_list':
            await reply(token, chatId, handleWlList());
            break;

          case '/wl_add':
            await reply(token, chatId, handleWlAdd(parts));
            break;

          case '/wl_remove':
            await reply(token, chatId, handleWlRemove(parts));
            break;

          case '/wl_tag':
            await reply(token, chatId, handleWlTag(parts));
            break;
        }
      } catch (err) {
        console.warn(`\x1b[90m[TG Poll] Command handler error: ${err?.message ?? err}\x1b[0m`);
      }
    }
  }
}

// ─── Broadcast alert to all subscribers ──────────────────────────────────────
async function broadcast(token, tokenName, mint, handle, tag, axiomUrl) {
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') return;

  const subs = loadSubs();
  if (subs.size === 0) return;

  const tagLine = tag ? `<b>Tag:</b>    🏷 <i>${tag}</i>\n` : '';

  const text = [
    `🚀 <b>Token Match</b>`,
    ``,
    `<b>Token:</b>  ${tokenName}`,
    `<b>Handle:</b> <code>${handle}</code>`,
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