/* Crypto Chess — operator signer.
 * Signs and submits settlement payouts FROM the escrow wallets.
 *
 * KEYS COME FROM ENVIRONMENT VARIABLES ONLY:
 *   OPERATOR_KEY_TRON    hex private key (TronWeb)
 *   OPERATOR_KEY_SOLANA  base58 secret key (Phantom-style export)
 *   OPERATOR_KEY_EVM     0x hex private key (Ethereum + Polygon share it)
 *   OPERATOR_KEY_XRPL    family seed, s... (XRPL)
 * Keys are read at send time, never logged, never written to disk, and
 * never committed. If a key is missing, sendPayouts throws a clear
 * error naming the variable — it never falls back to a placeholder.
 *
 * Safety:
 *   - dryRun: true returns the exact payloads that WOULD be submitted
 *     (token, recipient, minor-unit amount) without touching a chain
 *     or a key. Used by tests and the operator's preflight check.
 *   - Payouts are submitted sequentially per chain (no nonce races).
 *   - The game service is idempotent: a game settles once, so the
 *     signer is never asked to pay the same game twice.
 *   - Amounts are BigInt minor units end to end; no floats near money.
 *
 * Chain libraries are required lazily inside the builders, so merely
 * loading this module (tests, dry runs) never needs them installed.
 * For unit tests, pass injected `clients` instead of real libraries:
 *   { tron: {send}, solana: {send}, evm: {send}, xrpl: {send} }
 * each send({ chain, coin, outputs, config }) => { txHashes }.
 */
'use strict';

const { minorToValue } = require('./xrpl');

const KEY_ENV = {
  tron: 'OPERATOR_KEY_TRON',
  solana: 'OPERATOR_KEY_SOLANA',
  ethereum: 'OPERATOR_KEY_EVM',
  polygon: 'OPERATOR_KEY_EVM',
  xrpl: 'OPERATOR_KEY_XRPL',
};

function keyFor(chain) {
  const v = process.env[KEY_ENV[chain]];
  return v && v.trim() ? v.trim() : null;
}

function verifyKeys() {
  const out = {};
  for (const chain of Object.keys(KEY_ENV)) {
    // Booleans only — never return key material.
    out[chain] = !!keyFor(chain);
  }
  return out;
}

function dryRunPayloads(chain, coin, outputs, config) {
  return outputs.map((o) => ({
    chain, coin,
    from: config.escrow[chain],
    to: o.to,
    amountMinor: o.amountMinor.toString(),
    unsigned: true,
    note: 'DRY RUN — not submitted. Set dryRun:false and configure ' + KEY_ENV[chain] + ' to send for real.',
  }));
}

// ---- Real chain senders (lazy libs) ----
async function sendEvm({ chain, coin, outputs, config }) {
  const { ethers } = require('ethers');
  const key = keyFor(chain);
  if (!key) throw new Error('missing operator key: set ' + KEY_ENV[chain]);
  const rpcUrl = chain === 'ethereum' ? config.rpc.ethereumRpc : config.rpc.polygonRpc;
  const token = config.tokens[chain][coin];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(token.contract,
    ['function transfer(address to, uint256 amount) returns (bool)'], wallet);
  const txHashes = [];
  for (const o of outputs) {
    const tx = await contract.transfer(o.to, BigInt(o.amountMinor));
    const receipt = await tx.wait(1);
    txHashes.push(receipt.hash || tx.hash);
  }
  return { txHashes };
}

async function sendTron({ coin, outputs, config }) {
  const TronWeb = require('tronweb');
  const key = keyFor('tron');
  if (!key) throw new Error('missing operator key: set OPERATOR_KEY_TRON');
  const token = config.tokens.tron[coin];
  const tronWeb = new TronWeb({ fullHost: config.rpc.tronFullNode, privateKey: key });
  const contract = await tronWeb.contract().at(token.contract);
  const txHashes = [];
  for (const o of outputs) {
    const txid = await contract.transfer(o.to, o.amountMinor).send({ feeLimit: 100000000 });
    txHashes.push(txid);
  }
  return { txHashes };
}

async function sendSolana({ coin, outputs, config }) {
  const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } = require('@solana/spl-token');
  const key = keyFor('solana');
  if (!key) throw new Error('missing operator key: set OPERATOR_KEY_SOLANA');
  const token = config.tokens.solana[coin];
  const mint = new PublicKey(token.mint);
  const secret = decodeSolanaSecret(key);
  const payer = Keypair.fromSecretKey(secret);
  const connection = new Connection(config.rpc.solanaRpc, 'finalized');
  const escrowAta = await getAssociatedTokenAddress(mint, payer.publicKey, false);
  const txHashes = [];
  for (const o of outputs) {
    const destOwner = new PublicKey(o.to);
    const destAta = await getAssociatedTokenAddress(mint, destOwner, false);
    const instructions = [];
    const destInfo = await connection.getAccountInfo(destAta);
    if (!destInfo) {
      instructions.push(createAssociatedTokenAccountInstruction(payer.publicKey, destAta, destOwner, mint));
    }
    instructions.push(createTransferCheckedInstruction(
      escrowAta, mint, destAta, payer.publicKey, BigInt(o.amountMinor), token.decimals));
    const tx = new Transaction().add(...instructions);
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'finalized' });
    txHashes.push(sig);
  }
  return { txHashes };
}

function decodeSolanaSecret(key) {
  // Accept base58 (Phantom export) or a JSON array of numbers.
  const trimmed = key.trim();
  if (trimmed.startsWith('[')) {
    return Uint8Array.from(JSON.parse(trimmed));
  }
  // Minimal base58 decode (Bitcoin alphabet) — avoids an extra dep.
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of trimmed) {
    const idx = ALPH.indexOf(ch);
    if (idx < 0) throw new Error('OPERATOR_KEY_SOLANA is not valid base58');
    n = n * 58n + BigInt(idx);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of trimmed) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

async function sendXrpl({ coin, outputs, config }) {
  const xrpl = require('xrpl');
  const key = keyFor('xrpl');
  if (!key) throw new Error('missing operator key: set OPERATOR_KEY_XRPL');
  const token = config.tokens.xrpl[coin];
  const client = new xrpl.Client(config.rpc.xrplRpc);
  await client.connect();
  try {
    const wallet = xrpl.Wallet.fromSeed(key);
    const txHashes = [];
    for (const o of outputs) {
      const payment = {
        TransactionType: 'Payment',
        Account: config.escrow.xrpl,
        Destination: o.to,
        Amount: { currency: token.currency, issuer: token.issuer, value: minorToValue(BigInt(o.amountMinor)) },
      };
      const prepared = await client.autofill(payment);
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      const hash = result?.result?.hash || signed.hash;
      txHashes.push(hash);
    }
    return { txHashes };
  } finally {
    await client.disconnect();
  }
}

const REAL_SENDERS = {
  tron: sendTron,
  solana: sendSolana,
  ethereum: sendEvm,
  polygon: sendEvm,
  xrpl: sendXrpl,
};

function createSigner({ config, dryRun = false, clients = {} } = {}) {
  if (!config) throw new Error('signer requires config (loadConfig())');

  // sendPayouts({ chain, coin, outputs }) -> { chain, coin, txHashes, dryRun }
  // outputs: [{ to, amountMinor }] with real addresses already resolved.
  async function sendPayouts({ chain, coin, outputs }) {
    if (!outputs || !outputs.length) throw new Error('no payout outputs');
    if (dryRun) {
      return {
        chain, coin,
        payloads: dryRunPayloads(chain, coin, outputs, config),
        txHashes: [],
        dryRun: true,
      };
    }
    const injected = clients[chain] || (chain === 'ethereum' || chain === 'polygon' ? clients.evm : null);
    const sender = injected
      ? async (args) => injected.send(args)
      : REAL_SENDERS[chain];
    if (!sender) throw new Error('unsupported chain for payouts: ' + chain);
    const result = await sender({ chain, coin, outputs, config });
    return { chain, coin, txHashes: result.txHashes, dryRun: false };
  }

  return { sendPayouts, verifyKeys, dryRun: !!dryRun };
}

module.exports = { createSigner, verifyKeys, decodeSolanaSecret, KEY_ENV };
