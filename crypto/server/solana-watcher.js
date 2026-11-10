/* Crypto Chess — Solana watcher (USDC SPL deposits to escrow).
 * Source: getSignaturesForAddress on the escrow owner, then
 * getTransaction (finalized, jsonParsed) for each new signature.
 * A deposit is recognized from the transaction's token-balance deltas:
 * the escrow-owned USDC token account gains exactly the tier amount
 * while a sender-owned USDC account loses it. The mint must be the
 * official USDC mint and the commitment must be 'finalized'.
 * Default RPC is the public endpoint (rate-limited); set SOLANA_RPC_URL
 * to a dedicated provider for production volume.
 */
'use strict';

const { jsonRpc } = require('./rpc');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pure: turn one parsed transaction into the tx shape the Solana chain
// module's matchDeposit() expects, or null when it contains no
// USDC-to-escrow transfer. `escrowOwner` is the escrow wallet address.
function normalizeTransaction(signature, tx, escrowOwner) {
  if (!tx?.meta || tx.meta.err) return null;
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const byIndex = new Map();
  for (const b of pre) byIndex.set(b.accountIndex, b);
  for (const p of post) {
    if (p.mint !== USDC_MINT || p.owner !== escrowOwner) continue;
    const before = byIndex.get(p.accountIndex);
    const beforeAmt = before && before.mint === USDC_MINT ? BigInt(before.uiTokenAmount.amount) : 0n;
    const afterAmt = BigInt(p.uiTokenAmount.amount);
    const delta = afterAmt - beforeAmt;
    if (delta <= 0n) continue;
    // Sender = the owner of the same-mint account that lost this amount.
    let sender = null;
    for (const b of pre) {
      if (b.mint !== USDC_MINT) continue;
      const after = post.find((q) => q.accountIndex === b.accountIndex);
      const afterB = after && after.mint === USDC_MINT ? BigInt(after.uiTokenAmount.amount) : 0n;
      if (BigInt(b.uiTokenAmount.amount) - afterB === delta && b.owner !== escrowOwner) {
        sender = b.owner;
        break;
      }
    }
    if (!sender) continue;
    return {
      txHash: signature,
      owner: sender,
      toOwner: escrowOwner,
      mint: USDC_MINT,
      amountMinor: delta.toString(),
      commitment: 'finalized',
      coin: 'USDC',
    };
  }
  return null;
}

function createSolanaWatcher({ config, onDeposit, rpcImpl }) {
  const escrow = config.escrow.solana;
  const rpcUrl = config.rpc.solanaRpc;
  const rpc = rpcImpl || jsonRpc;

  let before = null; // newest signature seen (pagination cursor)
  let timer = null;
  let polling = false;

  async function poll() {
    if (polling) return [];
    polling = true;
    try {
      const params = [{ limit: 25, commitment: 'finalized' }];
      if (before) params[0].before = before;
      const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [escrow, ...params]);
      if (!Array.isArray(sigs) || !sigs.length) return [];
      before = sigs[0].signature;
      const found = [];
      // Oldest first so deposits credit in chain order.
      for (const s of [...sigs].reverse()) {
        try {
          const tx = await rpc(rpcUrl, 'getTransaction', [s.signature,
            { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
          const norm = normalizeTransaction(s.signature, tx, escrow);
          if (!norm) continue;
          found.push(norm);
          if (onDeposit) await onDeposit('solana', norm);
        } catch (e) {
          console.error('[watcher:solana] tx lookup failed ' + s.signature + ': ' + e.message);
        }
      }
      return found;
    } catch (e) {
      console.error('[watcher:solana] poll failed: ' + e.message);
      return [];
    } finally {
      polling = false;
    }
  }

  return {
    id: 'solana',
    poll,
    start(intervalMs) {
      if (timer) return;
      poll();
      timer = setInterval(() => { poll().catch(() => {}); }, intervalMs);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createSolanaWatcher, normalizeTransaction, USDC_MINT };
