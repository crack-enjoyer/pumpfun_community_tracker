// filename: whitelist.js
// Shared whitelist helpers — used by both index.js and telegram.js
'use strict';

const fs   = require('fs');
const path = require('path');

const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');

function loadWhitelist() {
  try {
    const raw = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));
    return raw.map(entry =>
      typeof entry === 'string'
        ? { handle: entry, tag: null }
        : { handle: entry.handle, tag: entry.tag ?? null }
    );
  } catch (err) { return []; }
}

function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

function normalise(h) { return h.replace(/^@/, '').toLowerCase(); }

function findEntry(handle, list) {
  return list.find(e => normalise(e.handle) === normalise(handle)) ?? null;
}

function isWhitelisted(handle, list) { return !!findEntry(handle, list); }

// Returns false if already present, true if added
function addHandle(handle, tag = null) {
  const list = loadWhitelist();
  if (findEntry(handle, list)) return false;
  list.push({ handle: handle.startsWith('@') ? handle : '@' + handle, tag: tag || null });
  saveWhitelist(list);
  return true;
}

// Returns false if not found, true if updated
function tagHandle(handle, tag) {
  const list  = loadWhitelist();
  const entry = findEntry(handle, list);
  if (!entry) return false;
  entry.tag = tag || null;
  saveWhitelist(list);
  return true;
}

// Returns false if not found, true if removed
function removeHandle(handle) {
  const list = loadWhitelist();
  const next = list.filter(e => normalise(e.handle) !== normalise(handle));
  if (next.length === list.length) return false;
  saveWhitelist(next);
  return true;
}

module.exports = { loadWhitelist, saveWhitelist, normalise, findEntry, isWhitelisted, addHandle, tagHandle, removeHandle };