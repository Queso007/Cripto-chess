/* Crypto Chess — XRPL watcher (RLUSD deposits to escrow).
 * Two feeds, same normalizer:
 *   1. Live websocket subscription to the escrow account
 *      (wss://xrplcluster.com) — validated transactions arrive in
 *      seconds.
 *   2. account_tx polling fallback (JSON-RPC) — catches anything the
 *      socket missed, e.g. across a restart. Polls the last ~10 minutes
 *      of ledgers on start.
 * A deposit counts only on a VALIDATED ledger with tesSUCCESS, the
 * exact RLUSD currency + Ripple's issuer, the exact tier amount, and
 * the game's destination tag (the tag is the game binding).
 */
'use strict';

const { fetchJson } = require('./rpc');

const RLUSD_CURRENCY = 'RLUSD';
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

// Pure: turn one XRPL transaction (websocket message or account_tx
// entry) into the tx shape the XRPL chain module's matchDeposit()
// expects. Returns null when it is not an RLUSD payment to escrow.
// `validated` must reflect a validated ledger — never trust an
// unvalidated transaction.
function normalizeTx(tx, meta, validated) {
  // Never trust an unvalidated transaction.
  if (!validated) return null;
  if (!tx || tx.TransactionType !== 'Payment') return null;
  const amount = tx.Amount;
  if (!amount || typeof amount !== 'object') return null; // native XRP, not RLUSD
  if (amount.currency !== RLUSD_CURRENCY || amount.issuer !== RLUSD_ISSUER) return null;
  if (meta?.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') return null;
  return {
    txHash: tx.hash,
    from: tx.Account,
    to: tx.Destination,
    currency: amount.currency,
    issuer: amount.issuer,
    value: amount.value,
    destinationTag: tx.DestinationTag === undefined ? null : String(tx.DestinationTag),
    validated: !!validated,
    coin: 'RLUSD',
  };
}

function createXrplWatcher({ config, onDeposit, fetchImpl }) {
  const escrow = config.escrow.xrpl;
  const wsUrl = config.rpc.xrplWs;
  const rpcUrl = config.rpc.xrplRpc;
  const fetchJ = fetchImpl || fetchJson;

  let ws = null;
  let timer = null;
  let polling = false;
  let lastLedgerMin = null; // account_tx cursor (ledger index)

  async function emit(tx) {
    if (!tx) return;
    if (onDeposit) await onDeposit('xrpl', tx);
  }

  function connectWs() {
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[watcher:xrpl] websocket connect failed: ' + e.message);
      return;
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ command: 'subscribe', accounts: [escrow] }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== 'transaction' || !msg.validated) return;
        emit(normalizeTx(msg.transaction, msg.meta, true));
      } catch (e) {
        console.error('[watcher:xrpl] bad websocket message: ' + e.message);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      ws = null;
      // Reconnect after a pause; polling keeps covering the gap.
      setTimeout(() => { if (timer) connectWs(); }, 10000);
    };
  }

  async function poll() {
    if (polling) return [];
    polling = true;
    try {
      // Start ~10 minutes back on first poll; afterwards resume from
      // the last ledger we scanned.
      if (lastLedgerMin === null) {
        const info = await fetchJ(rpcUrl, { method: 'POST', body: { method: 'ledger', params: [{ ledger_index: 'validated' }] } });
        const validatedLedger = Number(info?.result?.ledger_index);
        lastLedgerMin = Number.isFinite(validatedLedger) ? Math.max(0, validatedLedger - 200) : 0;
      }
      const found = [];
      let marker;
      do {
        const params = [{ account: escrow, ledger_index_min: lastLedgerMin, ledger_index_max: -1, binary: false, limit: 100, forward: false }];
        if (marker) params[0].marker = marker;
        const out = await fetchJ(rpcUrl, { method: 'POST', body: { method: 'account_tx', params } });
        const result = out?.result || {};
        for (const entry of result.transactions || []) {
          const tx = normalizeTx(entry.tx, entry.meta, result.validated === true);
          if (!tx) continue;
          found.push(tx);
          await emit(tx);
        }
        marker = result.marker;
      } while (marker);
      return found;
    } catch (e) {
      console.error('[watcher:xrpl] poll failed: ' + e.message);
      return [];
    } finally {
      polling = false;
    }
  }

  return {
    id: 'xrpl',
    poll,
    start(intervalMs) {
      if (timer) return;
      connectWs();
      poll();
      timer = setInterval(() => { poll().catch(() => {}); }, intervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    },
  };
}

module.exports = { createXrplWatcher, normalizeTx, RLUSD_CURRENCY, RLUSD_ISSUER };
