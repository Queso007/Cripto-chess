/* Crypto Chess — TRON escrow module (USDT TRC-20).
 * Low-fee route (transfers cost a few cents in TRX for energy/bandwidth;
 * the escrow wallet must hold a small TRX balance).
 * Deposit matching: TRC-20 Transfer to the escrow address, exact official
 * USDT contract, exact tier amount, registered sender, and confirmation
 * on a solidity (confirmed-block) node. TronGrid's transfer list is an
 * index, not proof — production must re-confirm each candidate on the
 * solidity node (see README). Never match on the symbol: anyone can
 * deploy a token named USDT.
 */
'use strict';

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

module.exports = {
  id: 'tron',
  label: 'TRON',
  coins: ['USDT'],
  tokens: { USDT: { contract: USDT_CONTRACT, decimals: 6 } },
  confirmationsRequired: 20, // confirmed (solidity) blocks — operator default
  rpcEnv: 'TRONGRID_API_KEY',
  explorer: 'https://tronscan.org',
  matchDeposit(tx, expected) {
    // tx: { from, to, tokenContract, amountMinor, confirmed (bool) }
    if (tx.to !== expected.to) return { ok: false, reason: 'recipient is not the escrow address' };
    if (tx.tokenContract !== USDT_CONTRACT) {
      return { ok: false, reason: 'token contract mismatch — not official USDT TRC-20 (clone rejected)' };
    }
    if (tx.from !== expected.sender) return { ok: false, reason: 'sender does not match the registered player address' };
    if (BigInt(tx.amountMinor) !== BigInt(expected.amountMinor)) {
      return { ok: false, reason: 'amount is not the exact tier amount' };
    }
    if (!tx.confirmed) return { ok: false, reason: 'transfer not yet confirmed on a solidity node' };
    return { ok: true };
  },
  buildSettlement(outputs, coin) {
    if (coin !== 'USDT') throw new Error('coin not offered on this chain: ' + coin);
    return outputs.map((o) => ({
      chain: 'tron',
      token: 'USDT',
      tokenContract: USDT_CONTRACT,
      decimals: 6,
      from: 'ESCROW_ADDRESS_FROM_CONFIG',
      to: o.to,
      amountMinor: o.amountMinor.toString(),
      call: 'TRC-20 transfer(address,uint256)',
      unsigned: true,
      note: 'REQUIRES operator signer (TronLink/TronWeb) + TRX for energy/bandwidth. Not submitted by this build.',
    }));
  },
};
