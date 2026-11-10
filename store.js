/* Crypto Chess — game record store.
 * Why this exists: the xApp lesson — in-memory games are wiped by every
 * restart/deploy. Live stake games must survive a process restart, so
 * game records (and the XRPL destination-tag allocator) are persisted
 * to a JSON file with atomic writes (temp file + rename).
 *
 * Honest limit: on Render's free tier the filesystem is ephemeral — a
 * redeploy still wipes the file. Attach a Render Disk (see render.yaml)
 * or move this store to Postgres for true durability. Within one
 * running instance, a crash/restart keeps every game.
 *
 * Store shape on disk:
 *   { games: { [gameId]: gameRecord }, nextTag: number }
 * A game record is the plain object created by the game service; it is
 * JSON-safe (amounts are decimal strings, never BigInt).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function createMemoryStore() {
  let data = { games: {}, nextTag: 100000000 };
  return {
    kind: 'memory',
    load() { return clone(data); },
    save(next) { data = clone(next); },
    get(gameId) { return data.games[gameId] ? clone(data.games[gameId]) : null; },
    put(game) { data.games[game.gameId] = clone(game); },
    all() { return Object.values(data.games).map(clone); },
    nextTag() { return data.nextTag++; },
    peekNextTag() { return data.nextTag; },
  };
}

function createFileStore(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let data = { games: {}, nextTag: 100000000 };
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.games) data = parsed;
    } catch (e) {
      // A corrupt store must not silently eat live games: keep the file
      // aside for manual inspection and start empty.
      const backup = filePath + '.corrupt-' + Date.now();
      fs.renameSync(filePath, backup);
      console.error('[store] corrupt store file moved to ' + backup + ': ' + e.message);
    }
  }
  function flush() {
    const tmp = filePath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  }
  return {
    kind: 'file',
    path: filePath,
    load() { return clone(data); },
    save(next) { data = clone(next); flush(); },
    get(gameId) { return data.games[gameId] ? clone(data.games[gameId]) : null; },
    put(game) { data.games[game.gameId] = clone(game); flush(); },
    all() { return Object.values(data.games).map(clone); },
    nextTag() { const t = data.nextTag++; flush(); return t; },
    peekNextTag() { return data.nextTag; },
  };
}

module.exports = { createMemoryStore, createFileStore };
