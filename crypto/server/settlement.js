/* Crypto Chess — crypto version: authoritative settlement math (server).
 * Stablecoins only: USDT, USDC, RLUSD. Stakes are exact dollar amounts.
 * All math in BigInt minor units (10^decimals per token). This module is
 * the single source of truth for payouts; the browser copy in
 * crypto/www/stablecoins.js mirrors these formulas for display only.
 *
 * Economics: win -> winner gets stake + 90% of loser's, operator 10% of
 * loser's. Draw -> each refunded 95%, operator 5% each. Never started ->
 * full refunds. Rounding floors; dust (none for the five whole-dollar
 * tiers) stays in escrow and is reported, never silently created or lost.
 */
'use strict';

const TIERS = [5, 10, 20, 40, 100];

function toMinor(dollars, decimals) {
  if (!Number.isInteger(dollars) || dollars <= 0) throw new Error('tier must be a positive whole dollar amount');
  return BigInt(dollars) * (10n ** BigInt(decimals));
}
function fromMinor(minor, decimals) {
  const s = minor.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals), frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? whole + '.' + frac : whole;
}

function settleWin(stakeMinor) {
  const operator = stakeMinor / 10n;
  const winner = stakeMinor + (stakeMinor - operator);
  return { winner, operator, dust: (stakeMinor * 2n) - winner - operator };
}
function settleDraw(stakeMinor) {
  const operatorEach = stakeMinor / 20n;
  const refundEach = stakeMinor - operatorEach;
  return { refundEach, operatorEach, dust: stakeMinor * 2n - refundEach * 2n - operatorEach * 2n };
}
function settleRefund(stakeMinor) {
  return { refundEach: stakeMinor, operatorEach: 0n, dust: 0n };
}

// result: { type: 'win', winner: 'white'|'black' } | { type: 'draw' } | { type: 'cancelled' }
// Returns outputs: [{ to: 'white'|'black'|'operator', amountMinor }] —
// the caller maps 'white'/'black'/'operator' to real addresses.
function settleGame(stakeMinor, result) {
  if (result.type === 'win') {
    const s = settleWin(stakeMinor);
    return { outputs: [
      { to: result.winner, amountMinor: s.winner },
      { to: 'operator', amountMinor: s.operator },
    ], dust: s.dust };
  }
  if (result.type === 'draw') {
    const s = settleDraw(stakeMinor);
    return { outputs: [
      { to: 'white', amountMinor: s.refundEach },
      { to: 'black', amountMinor: s.refundEach },
      { to: 'operator', amountMinor: s.operatorEach * 2n },
    ], dust: s.dust };
  }
  if (result.type === 'cancelled') {
    const s = settleRefund(stakeMinor);
    return { outputs: [
      { to: 'white', amountMinor: s.refundEach },
      { to: 'black', amountMinor: s.refundEach },
    ], dust: s.dust };
  }
  throw new Error('unknown result type: ' + result.type);
}

module.exports = { TIERS, toMinor, fromMinor, settleWin, settleDraw, settleRefund, settleGame };
