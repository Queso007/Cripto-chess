/* Crypto Chess — Tron watcher (USDT TRC-20 deposits to escrow).
 * Source: TronGrid TRC-20 transfer list for the escrow address, then
 * re-confirmation on the solidity node: a transfer counts only when
 * the latest SOLIDIFIED block is at least 20 blocks past the
 * transfer's block. TronGrid's list is an index, not proof — the
 * solidity check is what makes a deposit final. No API key is needed
 * at low poll rates; set TRONGRID_API_KEY for higher limits.
 */
'use strict';

const { fetchJson } = require('./rpc');

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const CONFIRMATIONS = 20;

// Pure: turn one TronGrid TRC-20 transfer into the tx shape the Tron
// chain module's matchDeposit() expects. `solidifiedBlock` is the
// latest solidified block number from the solidity node (null if the
// solidity call failed — then the transfer is NOT confirmed yet).
function normalizeTransfer(item, solidifiedBlock) {
  if (!item || item.token_info?.address !== USDT_CONTRACT) return null;
  const block = Number(item.block);
  const confirmed = Number.isFinite(block) && solidifiedBlock !== null &&
    (solidifiedBlock - block) >= CONFIRMATIONS;
  return {
    txHash: item.transaction_id,
    from: item.from,
    to: item.to,
    tokenContract: item.token_info.address,
    amountMinor: String(item.value),
    block,
    confirmed,
    coin: 'USDT',
  };
}

function createTronWatcher({ config, onDeposit, fetchImpl }) {
  const escrow = config.escrow.tron;
  const fullNode = config.rpc.tronFullNode;
  const solidityNode = config.rpc.tronSolidityNode;
  const apiKey = config.rpc.tronGridApiKey;
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const fetchJ = fetchImpl || fetchJson;

  let cursorTimestamp = Date.now() - 10 * 60 * 1000; // re-scan last 10 min on start
  let timer = null;
  let polling = false;

  async function solidifiedBlock() {
    try {
      const out = await fetchJ(`${solidityNode}/walletsolidity/getnowblock`, { method: 'POST', headers, body: {} });
      return Number(out?.block_header?.raw_data?.number);
    } catch (e) {
      console.error('[watcher:tron] solidity block lookup failed: ' + e.message);
      return null;
    }
  }

  async function poll() {
    if (polling) return [];
    polling = true;
    try {
      const solid = await solidifiedBlock();
      const url = `${fullNode}/v1/accounts/${escrow}/transactions/trc20` +
        `?only_confirmed=true&limit=50&min_timestamp=${cursorTimestamp}&order_by=block_timestamp,asc`;
      const out = await fetchJ(url, { headers });
      const items = Array.isArray(out?.data) ? out.data : [];
      const found = [];
      for (const item of items) {
        if (Number(item.block_timestamp) > cursorTimestamp) cursorTimestamp = Number(item.block_timestamp);
        const tx = normalizeTransfer(item, solid);
        if (!tx) continue;
        // Unconfirmed transfers are reported too: the service's
        // matchDeposit rejects them, and the next poll re-checks them
        // once the solidity block advances.
        found.push(tx);
        if (onDeposit) await onDeposit('tron', tx);
      }
      return found;
    } catch (e) {
      console.error('[watcher:tron] poll failed: ' + e.message);
      return [];
    } finally {
      polling = false;
    }
  }

  return {
    id: 'tron',
    poll,
    start(intervalMs) {
      if (timer) return;
      poll();
      timer = setInterval(() => { poll().catch(() => {}); }, intervalMs);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createTronWatcher, normalizeTransfer, USDT_CONTRACT, CONFIRMATIONS };
