/* Crypto Chess — EVM watcher (ERC-20 deposits to escrow).
 * Shared by Ethereum (USDT + RLUSD) and Polygon (native USDC).
 * Source: eth_getLogs for ERC-20 Transfer events to the escrow
 * address, filtered by token contract, with a confirmation window:
 * only logs in blocks at least `confirmationsRequired` behind the
 * chain tip are reported. No API key is needed for the default
 * PublicNode endpoints; set ETHEREUM_RPC_URL / POLYGON_RPC_URL to a
 * dedicated provider for production volume.
 */
'use strict';

const { jsonRpc } = require('./rpc');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function padAddress(addr) {
  return '0x' + String(addr).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
function unpadAddress(topic) {
  return '0x' + String(topic).slice(-40);
}
function hexToBigInt(hex) {
  return BigInt(hex);
}
function toHexBlock(n) {
  return '0x' + Number(n).toString(16);
}

// Pure: turn one eth_getLogs entry into the tx shape the EVM chain
// module's matchDeposit() expects. `latestBlock` is the chain tip, so
// confirmations can be computed here. Returns null for logs that are
// not transfers of the expected token to escrow.
function normalizeLog(log, { escrow, tokenContract, coin, latestBlock, confirmationsRequired }) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return null;
  if (log.address.toLowerCase() !== tokenContract.toLowerCase()) return null;
  if (unpadAddress(log.topics[2]).toLowerCase() !== escrow.toLowerCase()) return null;
  const blockNumber = parseInt(log.blockNumber, 16);
  const confirmations = latestBlock - blockNumber;
  return {
    txHash: log.transactionHash,
    from: unpadAddress(log.topics[1]),
    to: escrow,
    tokenContract,
    amountMinor: hexToBigInt(log.data).toString(),
    confirmations,
    blockNumber,
    coin,
  };
}

function createEvmWatcher({ config, chain, onDeposit, rpcImpl }) {
  // chain: 'ethereum' | 'polygon'
  const escrow = config.escrow[chain];
  const rpcUrl = chain === 'ethereum' ? config.rpc.ethereumRpc : config.rpc.polygonRpc;
  const tokens = config.tokens[chain];
  const confirmationsRequired = config.finality[chain];
  const rpc = rpcImpl || jsonRpc;

  // Cursor: last scanned block. On start, re-scan the last 500 blocks
  // so deposits made during downtime are caught; the service dedups
  // by transaction hash and by side, so re-scans are harmless.
  let cursor = null;
  let timer = null;
  let polling = false;

  async function poll() {
    if (polling) return [];
    polling = true;
    try {
      const latestHex = await rpc(rpcUrl, 'eth_blockNumber', []);
      const latest = parseInt(latestHex, 16);
      const safeTo = latest - confirmationsRequired;
      if (cursor === null) cursor = Math.max(0, latest - 500);
      if (safeTo <= cursor) return [];
      const found = [];
      for (const [coin, token] of Object.entries(tokens)) {
        const logs = await rpc(rpcUrl, 'eth_getLogs', [{
          address: token.contract,
          fromBlock: toHexBlock(cursor + 1),
          toBlock: toHexBlock(safeTo),
          topics: [TRANSFER_TOPIC, null, padAddress(escrow)],
        }]);
        for (const log of logs || []) {
          const tx = normalizeLog(log, {
            escrow, tokenContract: token.contract, coin,
            latestBlock: latest, confirmationsRequired,
          });
          if (!tx) continue;
          found.push(tx);
          if (onDeposit) await onDeposit(chain, tx);
        }
      }
      cursor = safeTo;
      return found;
    } catch (e) {
      console.error(`[watcher:${chain}] poll failed: ` + e.message);
      return [];
    } finally {
      polling = false;
    }
  }

  return {
    id: chain,
    poll,
    get cursor() { return cursor; },
    start(intervalMs) {
      if (timer) return;
      poll();
      timer = setInterval(() => { poll().catch(() => {}); }, intervalMs);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createEvmWatcher, normalizeLog, padAddress, unpadAddress, TRANSFER_TOPIC };
