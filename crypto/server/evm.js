/* Crypto Chess — EVM escrow core (shared by Polygon + Ethereum modules).
 * Deposit model: custodial escrow address. There are no destination tags
 * on EVM chains, so a deposit is matched by ALL of:
 *   - recipient == escrow address (case-insensitive)
 *   - token contract == the exact expected contract (NEVER the symbol —
 *     clone tokens reuse symbols; the bridged USDC.e contract on Polygon
 *     is a different asset from native USDC and is rejected here)
 *   - sender == the address the player registered at game creation
 *   - amount == the exact tier amount in minor units
 *   - confirmations >= the chain's configured threshold
 * Settlement payloads are CONSTRUCTED here (ERC-20 transfer calls) but
 * NOT signed or submitted: sending requires an operator signer, an RPC
 * endpoint, and native gas funds, none of which exist in this build.
 */
'use strict';

function normalizeAddress(a) { return String(a || '').toLowerCase(); }

function makeEvmChain(cfg) {
  // cfg: { id, label, chainId, tokens: { COIN: { contract, decimals } },
  //        confirmationsRequired, rpcEnv, explorer }
  return {
    id: cfg.id,
    label: cfg.label,
    chainId: cfg.chainId,
    coins: Object.keys(cfg.tokens),
    tokens: cfg.tokens,
    confirmationsRequired: cfg.confirmationsRequired,
    rpcEnv: cfg.rpcEnv,
    explorer: cfg.explorer,
    matchDeposit(tx, expected) {
      // tx: { from, to, tokenContract, amountMinor (string|bigint), confirmations }
      // expected: { to, coin, amountMinor, sender }
      if (normalizeAddress(tx.to) !== normalizeAddress(expected.to)) {
        return { ok: false, reason: 'recipient is not the escrow address' };
      }
      const token = cfg.tokens[expected.coin];
      if (!token) return { ok: false, reason: 'coin not offered on this chain: ' + expected.coin };
      if (normalizeAddress(tx.tokenContract) !== normalizeAddress(token.contract)) {
        return { ok: false, reason: 'token contract mismatch — not the accepted ' + expected.coin + ' contract (clone/bridged token rejected)' };
      }
      if (normalizeAddress(tx.from) !== normalizeAddress(expected.sender)) {
        return { ok: false, reason: 'sender does not match the registered player address' };
      }
      if (BigInt(tx.amountMinor) !== BigInt(expected.amountMinor)) {
        return { ok: false, reason: 'amount is not the exact tier amount' };
      }
      if (Number(tx.confirmations) < cfg.confirmationsRequired) {
        return { ok: false, reason: 'needs ' + cfg.confirmationsRequired + ' confirmations, has ' + tx.confirmations };
      }
      return { ok: true };
    },
    // outputs: [{ to, amountMinor }] with real addresses already resolved.
    // Returns unsigned ERC-20 transfer payloads — signer + RPC required.
    buildSettlement(outputs, coin) {
      const token = cfg.tokens[coin];
      if (!token) throw new Error('coin not offered on this chain: ' + coin);
      return outputs.map((o) => ({
        chain: cfg.id,
        token: coin,
        tokenContract: token.contract,
        decimals: token.decimals,
        from: 'ESCROW_ADDRESS_FROM_CONFIG',
        to: o.to,
        amountMinor: o.amountMinor.toString(),
        // Standard ERC-20 transfer(address,uint256) call data shape;
        // encode with your ABI library (e.g. ethers) before signing.
        call: 'transfer(address,uint256)',
        unsigned: true,
        note: 'REQUIRES operator signer + RPC (' + cfg.rpcEnv + ') + native gas funds. Not submitted by this build.',
      }));
    },
  };
}

module.exports = { makeEvmChain, normalizeAddress };
