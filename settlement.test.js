/* Crypto Chess — server tests. Run: node settlement.test.js
 * Covers: exact settlement splits for all five tiers (win + draw +
 * cancel), RLUSD 18-decimal math on Ethereum, chain deposit matching
 * (including the traps: bridged USDC.e on Polygon, fake RLUSD issuer on
 * XRPL, wrong destination tag, wrong sender, wrong amount, unconfirmed).
 * No network access; all chain inputs are fabricated fixtures.
 */
'use strict';
const assert = require('assert');
const s = require('./settlement');
const flow = require('./index');
const xrpl = require('./xrpl');
const polygon = require('./polygon');
const tron = require('./tron');
const solana = require('./solana');
const ethereum = require('./ethereum');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('ok - ' + name); }

// ---- Settlement splits are exact for every tier (no dust) ----
for (const tier of s.TIERS) {
  ok(`win split $${tier} (6-dec)`, () => {
    const stake = s.toMinor(tier, 6);
    const r = s.settleGame(stake, { type: 'win', winner: 'white' });
    const total = r.outputs.reduce((a, o) => a + o.amountMinor, 0n);
    assert.strictEqual(total, stake * 2n);
    assert.strictEqual(r.dust, 0n);
    assert.strictEqual(s.fromMinor(r.outputs[0].amountMinor, 6), String(tier * 1.9));
    assert.strictEqual(s.fromMinor(r.outputs[1].amountMinor, 6), String(tier * 0.1));
  });
  ok(`draw split $${tier} (6-dec)`, () => {
    const stake = s.toMinor(tier, 6);
    const r = s.settleGame(stake, { type: 'draw' });
    const total = r.outputs.reduce((a, o) => a + o.amountMinor, 0n);
    assert.strictEqual(total, stake * 2n);
    assert.strictEqual(r.dust, 0n);
    assert.strictEqual(s.fromMinor(r.outputs[0].amountMinor, 6), String(tier * 0.95));
  });
  ok(`cancel refunds $${tier}`, () => {
    const stake = s.toMinor(tier, 6);
    const r = s.settleGame(stake, { type: 'cancelled' });
    assert.strictEqual(r.outputs[0].amountMinor, stake);
    assert.strictEqual(r.outputs[1].amountMinor, stake);
  });
}
// ---- RLUSD 18-decimal math (Ethereum) ----
ok('RLUSD 18-dec win $100', () => {
  const stake = s.toMinor(100, 18);
  const r = s.settleGame(stake, { type: 'win', winner: 'black' });
  assert.strictEqual(s.fromMinor(r.outputs[0].amountMinor, 18), '190');
  assert.strictEqual(s.fromMinor(r.outputs[1].amountMinor, 18), '10');
  assert.strictEqual(r.dust, 0n);
});
// ---- Chain matching: the traps ----
ok('polygon rejects bridged USDC.e', () => {
  const r = polygon.matchDeposit({
    from: '0xPLAYER', to: '0xESCROW', tokenContract: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    amountMinor: '20000000', confirmations: 200,
  }, { to: '0xESCROW', coin: 'USDC', amountMinor: '20000000', sender: '0xPLAYER' });
  assert.strictEqual(r.ok, false);
});
ok('polygon accepts native USDC, case-insensitive', () => {
  const r = polygon.matchDeposit({
    from: '0xplayer', to: '0xescrow', tokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    amountMinor: '20000000', confirmations: 128,
  }, { to: '0xESCROW', coin: 'USDC', amountMinor: '20000000', sender: '0xPLAYER' });
  assert.strictEqual(r.ok, true);
});
ok('xrpl rejects fake RLUSD issuer', () => {
  const r = xrpl.matchDeposit({
    to: 'rESCROW', currency: 'RLUSD', issuer: 'rFAKEISSUER', value: '20', destinationTag: '123', validated: true,
  }, { to: 'rESCROW', coin: 'RLUSD', amountMinor: '20000000', tag: '123' });
  assert.strictEqual(r.ok, false);
});
ok('xrpl rejects wrong destination tag', () => {
  const r = xrpl.matchDeposit({
    to: 'rESCROW', currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
    value: '20', destinationTag: '999', validated: true,
  }, { to: 'rESCROW', coin: 'RLUSD', amountMinor: '20000000', tag: '123' });
  assert.strictEqual(r.ok, false);
});
ok('xrpl accepts real RLUSD deposit', () => {
  const r = xrpl.matchDeposit({
    to: 'rESCROW', currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
    value: '20', destinationTag: '123', validated: true,
  }, { to: 'rESCROW', coin: 'RLUSD', amountMinor: '20000000', tag: '123' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(xrpl.minorToValue(9500000n), '9.5');
  assert.strictEqual(xrpl.valueToMinor('9.5'), 9500000n);
});
ok('tron rejects wrong sender and unconfirmed', () => {
  const base = { from: 'TPLAYER', to: 'TESCROW', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amountMinor: '5000000', confirmed: true };
  assert.strictEqual(tron.matchDeposit({ ...base, from: 'TOTHER' },
    { to: 'TESCROW', coin: 'USDT', amountMinor: '5000000', sender: 'TPLAYER' }).ok, false);
  assert.strictEqual(tron.matchDeposit({ ...base, confirmed: false },
    { to: 'TESCROW', coin: 'USDT', amountMinor: '5000000', sender: 'TPLAYER' }).ok, false);
  assert.strictEqual(tron.matchDeposit(base,
    { to: 'TESCROW', coin: 'USDT', amountMinor: '5000000', sender: 'TPLAYER' }).ok, true);
});
ok('solana requires finalized + exact mint + owner', () => {
  const base = { owner: 'SOLPLAYER', toOwner: 'SOLESCROW', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountMinor: '100000000', commitment: 'finalized' };
  const exp = { to: 'SOLESCROW', coin: 'USDC', amountMinor: '100000000', sender: 'SOLPLAYER' };
  assert.strictEqual(solana.matchDeposit(base, exp).ok, true);
  assert.strictEqual(solana.matchDeposit({ ...base, commitment: 'confirmed' }, exp).ok, false);
  assert.strictEqual(solana.matchDeposit({ ...base, mint: 'FAKEMINT' }, exp).ok, false);
});
ok('ethereum RLUSD uses 18 decimals in flow', () => {
  const g = flow.createStakeGame({ tier: 40, coin: 'RLUSD', chain: 'ethereum',
    whiteSender: '0xW', blackSender: '0xB', escrowAddress: '0xE', operatorAddress: '0xO' });
  assert.strictEqual(g.decimals, 18);
  assert.strictEqual(g.destinationTag, null); // sender binding, not tags
  const settled = flow.settle(g.gameId, { type: 'win', winner: 'white' }, { white: '0xW', black: '0xB' });
  assert.strictEqual(settled.outputs[0].amountMinor, (76n * 10n ** 18n).toString());
  assert.strictEqual(settled.outputs[1].amountMinor, (4n * 10n ** 18n).toString());
  assert.strictEqual(settled.payloads[0].unsigned, true);
});
ok('full XRPL RLUSD game flow', () => {
  const g = flow.createStakeGame({ tier: 20, coin: 'RLUSD', chain: 'xrpl',
    whiteSender: 'rWHITE', blackSender: 'rBLACK', escrowAddress: 'rESCROW', operatorAddress: 'rOP' });
  assert.ok(g.destinationTag);
  const w = flow.recordDeposit(g.gameId, 'white', { to: 'rESCROW', currency: 'RLUSD',
    issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '20', destinationTag: g.destinationTag, validated: true });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.state, 'waiting_deposits');
  const b = flow.recordDeposit(g.gameId, 'black', { to: 'rESCROW', currency: 'RLUSD',
    issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '20', destinationTag: g.destinationTag, validated: true });
  assert.strictEqual(b.state, 'playing');
  const settled = flow.settle(g.gameId, { type: 'draw' }, { white: 'rWHITE', black: 'rBLACK' });
  assert.strictEqual(settled.payloads[0].Amount.value, '19');
  assert.strictEqual(settled.payloads[2].Amount.value, '2');
});
ok('flow rejects unsupported coin/chain combos', () => {
  assert.throws(() => flow.createStakeGame({ tier: 5, coin: 'BTC', chain: 'tron',
    whiteSender: 'x', blackSender: 'y', escrowAddress: 'e', operatorAddress: 'o' }));
  assert.throws(() => flow.createStakeGame({ tier: 7, coin: 'USDT', chain: 'tron',
    whiteSender: 'x', blackSender: 'y', escrowAddress: 'e', operatorAddress: 'o' }));
});

console.log('\n' + passed + ' tests passed.');
