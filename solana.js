/* Crypto Chess — Solana escrow module (USDC SPL).
 * Low fees. SPL tokens live in token accounts, not at the owner address:
 * deposits are matched by the token account's OWNER (the registered
 * sender), the mint, and the exact amount. Track via token-balance deltas
 * (pre/post balances) or getTokenAccountsByOwner filtered by mint — do not
 * rely on a single associated-token-account derivation, which misses
 * non-ATA token accounts. "finalized" commitment is required.
 */
'use strict';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

module.exports = {
  id: 'solana',
  label: 'Solana',
  coins: ['USDC'],
  tokens: { USDC: { mint: USDC_MINT, decimals: 6 } },
  confirmationsRequired: 'finalized',
  rpcEnv: 'SOLANA_RPC_URL',
  explorer: 'https://explorer.solana.com',
  matchDeposit(tx, expected) {
    // tx: { owner, toOwner, mint, amountMinor, commitment }
    // toOwner = owner of the destination token account (must be escrow).
    if (tx.toOwner !== expected.to) return { ok: false, reason: 'destination token account is not owned by the escrow address' };
    if (tx.mint !== USDC_MINT) {
      return { ok: false, reason: 'mint mismatch — not official USDC SPL mint (clone rejected)' };
    }
    if (tx.owner !== expected.sender) return { ok: false, reason: 'sender does not match the registered player address' };
    if (BigInt(tx.amountMinor) !== BigInt(expected.amountMinor)) {
      return { ok: false, reason: 'amount is not the exact tier amount' };
    }
    if (tx.commitment !== 'finalized') return { ok: false, reason: 'transaction is not finalized' };
    return { ok: true };
  },
  buildSettlement(outputs, coin) {
    if (coin !== 'USDC') throw new Error('coin not offered on this chain: ' + coin);
    return outputs.map((o) => ({
      chain: 'solana',
      token: 'USDC',
      mint: USDC_MINT,
      decimals: 6,
      from: 'ESCROW_ADDRESS_FROM_CONFIG',
      to: o.to,
      amountMinor: o.amountMinor.toString(),
      call: 'SPL Token transfer (owner -> destination token account)',
      unsigned: true,
      note: 'REQUIRES operator signer + RPC + a small SOL balance for fees. Destination token accounts must exist (create ATA if needed). Not submitted by this build.',
    }));
  },
};
