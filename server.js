/* Crypto Chess — payout service entry point.
 * Wires: config -> file store -> game service -> operator signer ->
 * chain watchers -> HTTP API -> deposit-timeout sweep.
 *
 * Run:  npm start            (node server.js)
 * Env:  see .env.example — keys ONLY from environment variables.
 *
 * Startup checklist (logged, never secret values):
 *   - escrow + operator addresses per chain
 *   - which operator keys are configured (booleans only)
 *   - dry-run mode, port, data file
 * If OPERATOR_API_TOKEN is unset, operator endpoints refuse all calls.
 */
'use strict';

const path = require('path');
const { loadConfig } = require('./config');
const { createFileStore } = require('./store');
const { createGameService } = require('./index');
const { createSigner } = require('./signer');
const { createHttpServer } = require('./http');
const { createTronWatcher } = require('./tron-watcher');
const { createSolanaWatcher } = require('./solana-watcher');
const { createEvmWatcher } = require('./evm-watcher');
const { createXrplWatcher } = require('./xrpl-watcher');

const config = loadConfig();
const dryRun = process.env.DRY_RUN === 'true';

const store = createFileStore(path.join(config.server.dataDir, 'games.json'));
const service = createGameService({ store, depositTimeoutMs: config.depositTimeoutSec * 1000 });
const signer = createSigner({ config, dryRun });
const httpApi = createHttpServer({ service, signer, config });

// Orphan deposits: transfers to escrow that match no waiting game
// (wrong amount, unregistered sender, stale game). They stay in
// escrow — log them loudly so the operator can reconcile manually.
const orphans = [];
async function onDeposit(chain, tx) {
  const hit = service.findGameForDeposit(chain, tx);
  if (!hit) {
    const entry = { chain, txHash: tx.txHash || null, at: new Date().toISOString(),
      coin: tx.coin, amountMinor: tx.amountMinor, from: tx.from || tx.owner || null,
      destinationTag: tx.destinationTag || null };
    orphans.push(entry);
    console.warn('[orphan] deposit matched no waiting game: ' + JSON.stringify(entry));
    return;
  }
  const res = service.recordDeposit(hit.game.gameId, hit.side, tx);
  if (res.ok) {
    console.log(`[deposit] ${chain} ${hit.game.gameId} ${hit.side} confirmed (tx ${tx.txHash}) -> ${res.state}`);
  } else {
    console.log(`[deposit] ${chain} ${hit.game.gameId} ${hit.side} rejected: ${res.reason}`);
  }
}

const watchers = [
  createTronWatcher({ config, onDeposit }),
  createSolanaWatcher({ config, onDeposit }),
  createEvmWatcher({ config, chain: 'ethereum', onDeposit }),
  createEvmWatcher({ config, chain: 'polygon', onDeposit }),
  createXrplWatcher({ config, onDeposit }),
];

// Deposit-timeout sweep: cancel expired games and pay the refunds.
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const cancelled = service.sweepExpired();
    for (const record of cancelled) {
      console.log(`[sweep] ${record.gameId} deposit timeout — refunding confirmed deposits`);
      try {
        const paid = await signer.sendPayouts({ chain: record.chain, coin: record.coin, outputs: record.outputs });
        service.recordSettlementTx(record.gameId, paid.txHashes);
        console.log(`[sweep] ${record.gameId} refunds paid: ${paid.txHashes.join(', ')}`);
      } catch (e) {
        console.error(`[sweep] ${record.gameId} refund payout failed (settlement recorded, retry via /retry-payout): ${e.message}`);
      }
    }
  } finally {
    sweeping = false;
  }
}

async function main() {
  await httpApi.listen(config.server.port, config.server.host);
  for (const w of watchers) {
    const interval = w.id === 'xrpl' ? config.poll.xrplMs
      : w.id === 'tron' ? config.poll.tronMs
      : w.id === 'solana' ? config.poll.solanaMs
      : config.poll.evmMs;
    w.start(interval);
  }
  setInterval(() => { sweep().catch((e) => console.error('[sweep] ' + e.message)); }, config.poll.sweepMs);

  const keys = signer.verifyKeys();
  console.log('[crypto-chess payout service] listening on ' + config.server.host + ':' + config.server.port);
  console.log('[config] data file: ' + store.path + ' (' + service.games.size + ' games recovered)');
  console.log('[config] dryRun: ' + dryRun + ' | deposit timeout: ' + config.depositTimeoutSec + 's');
  console.log('[config] escrow: ' + JSON.stringify(config.escrow));
  console.log('[config] operator: ' + JSON.stringify(config.operator));
  console.log('[config] operator keys configured: ' + JSON.stringify(keys));
  if (!config.server.operatorApiToken) {
    console.warn('[config] WARNING: OPERATOR_API_TOKEN is not set — operator endpoints (/result, /cancel, /retry-payout) will refuse all calls.');
  }
  if (Object.values(keys).some((v) => !v)) {
    console.warn('[config] WARNING: some operator keys are missing — payouts on those chains will fail until the keys are set in Render secrets.');
  }
}

function shutdown(signal) {
  console.log('[shutdown] ' + signal + ' — stopping watchers and HTTP server');
  for (const w of watchers) { try { w.stop(); } catch (e) {} }
  httpApi.close().then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  main().catch((e) => {
    console.error('[fatal] ' + e.stack);
    process.exit(1);
  });
}

// Exported for tests (server.test.js starts the service in-process).
module.exports = { config, service, signer, httpApi, watchers, onDeposit, sweep, orphans };
