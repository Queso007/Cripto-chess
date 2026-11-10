/* Crypto Chess — payout service tests. Run: node server.test.js
 * Covers (no network, no keys, no real funds):
 *   - config defaults: exact escrow/operator addresses + finality
 *   - file store: persistence across instances + tag allocator
 *   - service: idempotent settle (no double-pay), deposit timeout
 *     sweep (cancel + full refunds), deposit matching incl. duplicates
 *   - watcher normalizers with fabricated RPC fixtures (Tron/Solana/
 *     EVM/XRPL), including the traps (wrong token, unconfirmed)
 *   - signer dry-run: exact payloads without keys or network; missing
 *     key error names the env var
 *   - HTTP API in-process: create/get/result/cancel + operator auth
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('./config');
const { createMemoryStore, createFileStore } = require('./store');
const { createGameService } = require('./index');
const { createSigner, verifyKeys } = require('./signer');
const { createHttpServer } = require('./http');
const { normalizeTransfer } = require('./tron-watcher');
const { normalizeTransaction } = require('./solana-watcher');
const { normalizeLog, TRANSFER_TOPIC } = require('./evm-watcher');
const { normalizeTx } = require('./xrpl-watcher');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('ok - ' + name); });
}

const tests = [];

// ---- Config defaults are the agreed production values ----
tests.push(['config escrow + operator addresses', () => {
  const c = loadConfig();
  assert.strictEqual(c.escrow.tron, 'TBgET9wfANqaUFbA1PMGuok2NmRMVVRsoz');
  assert.strictEqual(c.escrow.solana, '6h9vjU9RjsKGFMAE4y1PYSirytRc4oZJ3YZc5cgJ1KQm');
  assert.strictEqual(c.escrow.ethereum, '0xA527Dbf12329D45E4E296d75C1983bA23AAf5570');
  assert.strictEqual(c.escrow.polygon, '0xA527Dbf12329D45E4E296d75C1983bA23AAf5570');
  assert.strictEqual(c.escrow.xrpl, 'rPJYyWys3Q3DhR2bTZf8NhzmfVFPoizMRn');
  assert.strictEqual(c.operator.tron, 'TGrGfLCtsuwjGyL5ooivNpqjbBpZDC4s34');
  assert.strictEqual(c.operator.solana, '7wquMQLyAE3bmPiJS4hznZmSYn6f9USRqSdLfn1ZTxkH');
  assert.strictEqual(c.operator.ethereum, '0x76ae8ee24a9D053439530F83bd152ed50b677Beb');
  assert.strictEqual(c.operator.polygon, '0x76ae8ee24a9D053439530F83bd152ed50b677Beb');
  assert.strictEqual(c.operator.xrpl, 'rn4ZbrXPMCEPrufA6QLGsBfwu7nsw3PmUm');
  assert.strictEqual(c.finality.tron, 20);
  assert.strictEqual(c.finality.solana, 'finalized');
  assert.strictEqual(c.finality.polygon, 128);
  assert.strictEqual(c.finality.ethereum, 12);
  assert.strictEqual(c.finality.xrpl, 'validated');
  assert.deepStrictEqual(c.tiers, [5, 10, 20, 40, 100]);
  assert.strictEqual(c.depositTimeoutSec, 600);
  // Env overrides work.
  process.env.ESCROW_TRON = 'TTEST';
  assert.strictEqual(loadConfig().escrow.tron, 'TTEST');
  delete process.env.ESCROW_TRON;
}]);

// ---- File store survives a reload; tags never repeat ----
tests.push(['file store persistence + tag allocator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));
  const file = path.join(dir, 'games.json');
  const s1 = createFileStore(file);
  const t1 = s1.nextTag();
  const t2 = s1.nextTag();
  assert.strictEqual(t2, t1 + 1);
  s1.put({ gameId: 'cc-test', state: 'waiting_deposits', tier: 20 });
  const s2 = createFileStore(file);
  assert.strictEqual(s2.get('cc-test').state, 'waiting_deposits');
  assert.strictEqual(s2.peekNextTag(), t2 + 1);
  assert.strictEqual(s2.nextTag(), t2 + 1); // no tag reuse after reload
  fs.rmSync(dir, { recursive: true, force: true });
}]);

// ---- Service: idempotent settle, timeout sweep, matching ----
tests.push(['settle is idempotent (no double-pay)', () => {
  const svc = createGameService({ store: createMemoryStore() });
  const g = svc.createStakeGame({ tier: 20, coin: 'USDT', chain: 'tron',
    whiteSender: 'TW', blackSender: 'TB', escrowAddress: 'TE', operatorAddress: 'TO' });
  const first = svc.settle(g.gameId, { type: 'win', winner: 'white' }, { white: 'TW', black: 'TB' });
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.outputs[0].amountMinor, '38000000');
  assert.strictEqual(first.outputs[1].amountMinor, '2000000');
  const second = svc.settle(g.gameId, { type: 'win', winner: 'black' }, { white: 'TW', black: 'TB' });
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.outputs[0].amountMinor, '38000000'); // winner did NOT flip
  assert.strictEqual(svc.getGame(g.gameId).state, 'settled');
}]);

tests.push(['deposit timeout sweep cancels + refunds in full', () => {
  let now = 1000000;
  const svc = createGameService({ store: createMemoryStore(), clock: () => now });
  const g = svc.createStakeGame({ tier: 10, coin: 'USDT', chain: 'tron',
    whiteSender: 'TW', blackSender: 'TB', escrowAddress: 'TE', operatorAddress: 'TO' });
  // Only white deposits.
  const r = svc.recordDeposit(g.gameId, 'white', { from: 'TW', to: 'TE',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amountMinor: '10000000', confirmed: true, txHash: 'tx1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'waiting_deposits');
  now += 601000; // past the 600s deadline
  const cancelled = svc.sweepExpired();
  assert.strictEqual(cancelled.length, 1);
  assert.strictEqual(cancelled[0].result, 'cancelled');
  assert.strictEqual(cancelled[0].outputs[0].amountMinor, '10000000'); // full refund
  assert.strictEqual(cancelled[0].outputs[1].amountMinor, '10000000');
  assert.strictEqual(cancelled[0].outputs.length, 2); // operator gets nothing
  assert.strictEqual(svc.getGame(g.gameId).state, 'cancelled');
  assert.strictEqual(svc.sweepExpired().length, 0); // sweep is idempotent too
}]);

tests.push(['duplicate deposit tx is ignored, not double-credited', () => {
  const svc = createGameService({ store: createMemoryStore() });
  const g = svc.createStakeGame({ tier: 5, coin: 'USDT', chain: 'tron',
    whiteSender: 'TW', blackSender: 'TB', escrowAddress: 'TE', operatorAddress: 'TO' });
  const tx = { from: 'TW', to: 'TE', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    amountMinor: '5000000', confirmed: true, txHash: 'tx-dup' };
  assert.strictEqual(svc.recordDeposit(g.gameId, 'white', tx).ok, true);
  assert.strictEqual(svc.recordDeposit(g.gameId, 'white', tx).ok, false);
  assert.strictEqual(svc.getGame(g.gameId).state, 'waiting_deposits'); // still waiting on black
}]);

tests.push(['findGameForDeposit: XRPL by tag, EVM by sender+amount', () => {
  const svc = createGameService({ store: createMemoryStore() });
  const x = svc.createStakeGame({ tier: 20, coin: 'RLUSD', chain: 'xrpl',
    whiteSender: 'rW', blackSender: 'rB', escrowAddress: 'rE', operatorAddress: 'rO' });
  const hit = svc.findGameForDeposit('xrpl', { destinationTag: x.destinationTag, from: 'rW', amountMinor: '20000000', coin: 'RLUSD' });
  assert.ok(hit);
  assert.strictEqual(hit.game.gameId, x.gameId);
  assert.strictEqual(hit.side, 'white');
  assert.strictEqual(svc.findGameForDeposit('xrpl', { destinationTag: '999999999', amountMinor: '20000000' }), null);

  const e = svc.createStakeGame({ tier: 20, coin: 'USDT', chain: 'ethereum',
    whiteSender: '0xW', blackSender: '0xB', escrowAddress: '0xE', operatorAddress: '0xO' });
  const hit2 = svc.findGameForDeposit('ethereum', { from: '0xb', amountMinor: '20000000', coin: 'USDT' });
  assert.ok(hit2);
  assert.strictEqual(hit2.game.gameId, e.gameId);
  assert.strictEqual(hit2.side, 'black'); // case-insensitive sender match
  assert.strictEqual(svc.findGameForDeposit('ethereum', { from: '0xSTRANGER', amountMinor: '20000000', coin: 'USDT' }), null);
  assert.strictEqual(svc.findGameForDeposit('ethereum', { from: '0xW', amountMinor: '10000000', coin: 'USDT' }), null);
}]);

// ---- Watcher normalizers (fabricated RPC fixtures) ----
tests.push(['tron normalizer: confirmed at 20 blocks, rejects clone token', () => {
  const item = { transaction_id: 'txT', from: 'TP', to: 'TE', value: '20000000',
    token_info: { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }, block_timestamp: 1, block: 100 };
  assert.strictEqual(normalizeTransfer(item, 120).confirmed, true);
  assert.strictEqual(normalizeTransfer(item, 119).confirmed, false); // only 19 ahead
  assert.strictEqual(normalizeTransfer(item, null).confirmed, false); // solidity lookup failed
  assert.strictEqual(normalizeTransfer({ ...item, token_info: { address: 'TFAKE' } }, 200), null);
}]);

tests.push(['solana normalizer: USDC delta + sender from token balances', () => {
  const tx = {
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: 'SOLPLAYER', uiTokenAmount: { amount: '100000000' } },
        { accountIndex: 2, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: 'SOLESCROW', uiTokenAmount: { amount: '0' } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: 'SOLPLAYER', uiTokenAmount: { amount: '80000000' } },
        { accountIndex: 2, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: 'SOLESCROW', uiTokenAmount: { amount: '20000000' } },
      ],
    },
  };
  const n = normalizeTransaction('sig1', tx, 'SOLESCROW');
  assert.ok(n);
  assert.strictEqual(n.owner, 'SOLPLAYER');
  assert.strictEqual(n.amountMinor, '20000000');
  assert.strictEqual(n.commitment, 'finalized');
  assert.strictEqual(normalizeTransaction('sig2', { meta: { err: 'err', preTokenBalances: [], postTokenBalances: [] } }, 'SOLESCROW'), null);
  const wrongMint = JSON.parse(JSON.stringify(tx));
  wrongMint.meta.postTokenBalances[1].mint = 'FAKEMINT';
  assert.strictEqual(normalizeTransaction('sig3', wrongMint, 'SOLESCROW'), null);
}]);

tests.push(['evm normalizer: Transfer log to escrow, confirmations counted', () => {
  const escrow = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const token = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
  const log = {
    address: token,
    blockNumber: '0x64', // 100
    transactionHash: '0xhash',
    topics: [TRANSFER_TOPIC,
      '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '0x000000000000000000000000' + escrow.slice(2)],
    data: '0x0000000000000000000000000000000000000000000000000000000001312d00', // 20000000
  };
  const n = normalizeLog(log, { escrow, tokenContract: token, coin: 'USDC', latestBlock: 228, confirmationsRequired: 128 });
  assert.ok(n);
  assert.strictEqual(n.amountMinor, '20000000');
  assert.strictEqual(n.confirmations, 128);
  assert.strictEqual(n.from, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.strictEqual(normalizeLog({ ...log, address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' },
    { escrow, tokenContract: token, coin: 'USDC', latestBlock: 228, confirmationsRequired: 128 }), null); // bridged USDC.e
  const short = normalizeLog(log, { escrow, tokenContract: token, coin: 'USDC', latestBlock: 200, confirmationsRequired: 128 });
  assert.strictEqual(short.confirmations, 100); // watcher reports it; matchDeposit rejects <128
}]);

tests.push(['xrpl normalizer: RLUSD only, validated only', () => {
  const tx = { TransactionType: 'Payment', hash: 'h1', Account: 'rP', Destination: 'rE',
    DestinationTag: 123, Amount: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '20' } };
  const meta = { TransactionResult: 'tesSUCCESS' };
  const n = normalizeTx(tx, meta, true);
  assert.ok(n);
  assert.strictEqual(n.destinationTag, '123');
  assert.strictEqual(normalizeTx(tx, meta, false), null); // unvalidated
  assert.strictEqual(normalizeTx({ ...tx, Amount: '1000000' }, meta, true), null); // native XRP
  assert.strictEqual(normalizeTx({ ...tx, Amount: { ...tx.Amount, issuer: 'rFAKE' } }, meta, true), null);
  assert.strictEqual(normalizeTx({ ...tx, TransactionType: 'OfferCreate' }, meta, true), null);
}]);

// ---- Signer dry-run + key errors ----
tests.push(['signer dry-run returns exact payloads, no keys needed', async () => {
  const config = loadConfig();
  const signer = createSigner({ config, dryRun: true });
  const out = await signer.sendPayouts({ chain: 'ethereum', coin: 'RLUSD', outputs: [
    { to: '0xW', amountMinor: (76n * 10n ** 18n).toString() },
    { to: '0xO', amountMinor: (4n * 10n ** 18n).toString() },
  ] });
  assert.strictEqual(out.dryRun, true);
  assert.deepStrictEqual(out.txHashes, []);
  assert.strictEqual(out.payloads[0].amountMinor, (76n * 10n ** 18n).toString());
  assert.strictEqual(out.payloads[0].from, config.escrow.ethereum);
  assert.strictEqual(signer.verifyKeys().xrpl, false); // no keys in test env
}]);

tests.push(['signer without key throws naming the env var', async () => {
  const config = loadConfig();
  const saved = {};
  for (const k of ['OPERATOR_KEY_TRON', 'OPERATOR_KEY_SOLANA', 'OPERATOR_KEY_EVM', 'OPERATOR_KEY_XRPL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    assert.deepStrictEqual(verifyKeys(), { tron: false, solana: false, ethereum: false, polygon: false, xrpl: false });
    const signer = createSigner({ config, dryRun: false });
    await assert.rejects(
      signer.sendPayouts({ chain: 'tron', coin: 'USDT', outputs: [{ to: 'T', amountMinor: '100' }] }),
      /OPERATOR_KEY_TRON/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v !== undefined) process.env[k] = v; }
  }
}]);

tests.push(['signer accepts injected clients (mocked submit)', async () => {
  const config = loadConfig();
  const seen = [];
  const signer = createSigner({ config, dryRun: false, clients: {
    evm: { send: async ({ chain, coin, outputs }) => { seen.push([chain, coin, outputs.length]); return { txHashes: ['0xabc'] }; } },
  } });
  const out = await signer.sendPayouts({ chain: 'polygon', coin: 'USDC', outputs: [{ to: '0xW', amountMinor: '19000000' }] });
  assert.deepStrictEqual(out.txHashes, ['0xabc']);
  assert.deepStrictEqual(seen, [['polygon', 'USDC', 1]]);
}]);

// ---- HTTP API in-process ----
tests.push(['HTTP API: create -> deposits -> result (dry-run) -> duplicate', async () => {
  const config = loadConfig();
  config.server.operatorApiToken = 'test-token';
  const svc = createGameService({ store: createMemoryStore() });
  const signer = createSigner({ config, dryRun: true });
  const api = createHttpServer({ service: svc, signer, config });
  await api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${api.server.address().port}`;
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.strictEqual(health.ok, true);
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.strictEqual(cfg.escrow.tron, 'TBgET9wfANqaUFbA1PMGuok2NmRMVVRsoz');

    const created = await (await fetch(base + '/api/games', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 20, coin: 'USDT', chain: 'tron', whiteSender: 'TW', blackSender: 'TB' }),
    })).json();
    assert.ok(created.gameId);
    assert.strictEqual(created.destinationTag, null);

    const noAuth = await fetch(base + `/api/games/${created.gameId}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'win', winner: 'white' }),
    });
    assert.strictEqual(noAuth.status, 401);

    const settled = await (await fetch(base + `/api/games/${created.gameId}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Token': 'test-token' },
      body: JSON.stringify({ type: 'win', winner: 'white' }),
    })).json();
    assert.strictEqual(settled.dryRun, true);
    assert.strictEqual(settled.outputs[0].amountMinor, '38000000');

    const again = await (await fetch(base + `/api/games/${created.gameId}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Token': 'test-token' },
      body: JSON.stringify({ type: 'win', winner: 'black' }),
    })).json();
    assert.strictEqual(again.duplicate, true); // winner did NOT flip
    assert.strictEqual(again.outputs[0].amountMinor, '38000000');

    const state = await (await fetch(base + `/api/games/${created.gameId}`)).json();
    assert.strictEqual(state.state, 'settled');
  } finally {
    await api.close();
  }
}]);

tests.push(['HTTP API: cancel refunds in full, operator endpoints fail closed', async () => {
  const config = loadConfig();
  config.server.operatorApiToken = ''; // unset -> fail closed
  const svc = createGameService({ store: createMemoryStore() });
  const signer = createSigner({ config, dryRun: true });
  const api = createHttpServer({ service: svc, signer, config });
  await api.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${api.server.address().port}`;
  try {
    const created = await (await fetch(base + '/api/games', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 5, coin: 'USDT', chain: 'tron', whiteSender: 'TW', blackSender: 'TB' }),
    })).json();
    const denied = await fetch(base + `/api/games/${created.gameId}/cancel`, {
      method: 'POST', headers: { 'X-Operator-Token': 'anything' },
    });
    assert.strictEqual(denied.status, 503);

    config.server.operatorApiToken = 'test-token';
    const cancelled = await (await fetch(base + `/api/games/${created.gameId}/cancel`, {
      method: 'POST', headers: { 'X-Operator-Token': 'test-token' },
    })).json();
    assert.strictEqual(cancelled.result, 'cancelled');
    assert.strictEqual(cancelled.outputs[0].amountMinor, '5000000');
    assert.strictEqual(cancelled.outputs.length, 2);
  } finally {
    await api.close();
  }
}]);

(async () => {
  for (const [name, fn] of tests) await ok(name, fn);
  console.log('\n' + passed + ' tests passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
