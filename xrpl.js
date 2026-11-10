/* Crypto Chess — XRP Ledger escrow module (RLUSD).
 * This is the chain closest to the existing xApp escrow experience: the
 * proven address + destination-tag pattern is reused here, but for RLUSD
 * (an issued token) instead of native XRP.
 *
 * Rules that must hold, or the deposit is rejected:
 *   - Currency code is exactly 'RLUSD' AND issuer is exactly Ripple's
 *     mainnet issuer below. Any other RLUSD code is a fake token.
 *   - Destination tag equals the game's tag (links payment to game).
 *   - Recipient is the escrow address; amount is the exact tier amount;
 *     transaction is validated on a closed ledger.
 * Trust lines: the escrow wallet must trust Ripple's RLUSD issuer, and
 * each player must trust the issuer in their own wallet to hold RLUSD.
 * XRPL IOU values are decimal strings (up to 15 significant digits). The
 * app only moves whole-dollar tiers, so amounts are converted to/from
 * 6-decimal minor units exactly (e.g. 9.5 RLUSD <-> 9500000).
 * Settlement payloads below are real XRPL Payment JSON, UNSIGNED —
 * signing requires the escrow key, which is never in this repo.
 */
'use strict';

const RLUSD_CURRENCY = 'RLUSD';
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const DECIMALS = 6;

function minorToValue(minor) {
  const s = minor.toString().padStart(DECIMALS + 1, '0');
  const whole = s.slice(0, -DECIMALS), frac = s.slice(-DECIMALS).replace(/0+$/, '');
  return frac ? whole + '.' + frac : whole;
}
function valueToMinor(value) {
  // Exact for the decimal strings this app produces (<= 6 decimal places).
  const [whole, frac = ''] = String(value).split('.');
  if (frac.length > DECIMALS) throw new Error('RLUSD value has more precision than the app supports: ' + value);
  return BigInt(whole) * (10n ** BigInt(DECIMALS)) + BigInt((frac + '000000').slice(0, DECIMALS));
}

module.exports = {
  id: 'xrpl',
  label: 'XRP Ledger',
  coins: ['RLUSD'],
  tokens: { RLUSD: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, decimals: DECIMALS } },
  confirmationsRequired: 'validated',
  rpcEnv: 'XRPL_JSON_RPC',
  explorer: 'https://livenet.xrpl.org',
  RLUSD_CURRENCY,
  RLUSD_ISSUER,
  minorToValue,
  valueToMinor,
  matchDeposit(tx, expected) {
    // tx: { to, currency, issuer, value (string), destinationTag, validated (bool) }
    if (tx.to !== expected.to) return { ok: false, reason: 'recipient is not the escrow address' };
    if (tx.currency !== RLUSD_CURRENCY || tx.issuer !== RLUSD_ISSUER) {
      return { ok: false, reason: 'not Ripple\'s RLUSD (wrong currency code or issuer — fake token rejected)' };
    }
    if (String(tx.destinationTag) !== String(expected.tag)) {
      return { ok: false, reason: 'destination tag does not match this game' };
    }
    if (valueToMinor(tx.value) !== BigInt(expected.amountMinor)) {
      return { ok: false, reason: 'amount is not the exact tier amount' };
    }
    if (!tx.validated) return { ok: false, reason: 'transaction is not on a validated ledger' };
    return { ok: true };
  },
  buildSettlement(outputs, coin) {
    if (coin !== 'RLUSD') throw new Error('coin not offered on this chain: ' + coin);
    return outputs.map((o) => ({
      TransactionType: 'Payment',
      Account: 'ESCROW_ADDRESS_FROM_CONFIG',
      Destination: o.to,
      Amount: { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value: minorToValue(BigInt(o.amountMinor)) },
      unsigned: true,
      note: 'UNSIGNED XRPL Payment JSON. Requires the escrow key to sign and submit. Never commit a key.',
    }));
  },
};
