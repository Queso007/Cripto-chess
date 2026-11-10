/* Crypto Chess — crypto version: server game flow (escrow orchestration).
 * Wiring layer between the chain modules, settlement math, watchers, and
 * the operator signer.
 *
 * Flow:
 *   1. createStakeGame({ tier, coin, chain, whiteSender, blackSender,
 *      escrowAddress, operatorAddress, payoutAddresses? })
 *      -> deposit instructions (escrow address; XRPL destination tag).
 *      Both players stake the SAME tier. No price conversion anywhere.
 *   2. Watchers feed transfers into recordDeposit(gameId, side, tx) —
 *      the chain module matches (token identity + exact amount +
 *      sender/tag + finality). Duplicate transaction hashes are ignored.
 *   3. When both deposits confirm, the game starts. On game end,
 *      settleGame() computes outputs; the operator signer submits the
 *      payouts. settle() is IDEMPOTENT: settling an already-settled
 *      game returns the recorded settlement instead of paying twice.
 *   4. If deposits do not both land within the timeout (600s), the
 *      sweep cancels the game and confirmed deposits are refunded in
 *      full via the same settlement path.
 *
 * Persistence: games live in a store (see store.js). The default
 * in-memory store keeps the old behaviour for tests; the production
 * service passes a file store so a restart does not wipe live games
 * (the xApp lesson). Amounts are decimal strings in records — never
 * BigInt in persisted JSON.
 */
'use strict';

const settlement = require('./settlement');
const { createMemoryStore } = require('./store');
const chains = {
  tron: require('./tron'),
  solana: require('./solana'),
  polygon: require('./polygon'),
  ethereum: require('./ethereum'),
  xrpl: require('./xrpl'),
};

const DEFAULT_DEPOSIT_TIMEOUT_MS = 600000;

function createGameService({ store, clock, depositTimeoutMs } = {}) {
  const storeImpl = store || createMemoryStore();
  const now = clock || (() => Date.now());
  const timeoutMs = depositTimeoutMs || DEFAULT_DEPOSIT_TIMEOUT_MS;

  // Live index, loaded from the store at startup (crash recovery).
  const games = new Map();
  for (const g of storeImpl.all()) games.set(g.gameId, g);

  function persist(game) {
    games.set(game.gameId, game);
    storeImpl.put(game);
  }

  function chainFor(chainId) {
    const c = chains[chainId];
    if (!c) throw new Error('unsupported chain: ' + chainId);
    return c;
  }
  function tokenDecimals(chainId, coin) {
    const c = chainFor(chainId);
    const t = c.tokens[coin];
    if (!t) throw new Error(`coin ${coin} is not offered on chain ${chainId}`);
    return t.decimals;
  }

  function createStakeGame({ tier, coin, chain, whiteSender, blackSender,
    escrowAddress, operatorAddress, payoutAddresses }) {
    if (!settlement.TIERS.includes(tier)) throw new Error('tier must be one of ' + settlement.TIERS.join(', '));
    const mod = chainFor(chain);
    if (!mod.coins.includes(coin)) throw new Error(`coin ${coin} is not offered on chain ${chain}`);
    const decimals = tokenDecimals(chain, coin);
    const stakeMinor = settlement.toMinor(tier, decimals);
    const gameId = 'cc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const createdAt = now();
    const payout = payoutAddresses || {};
    const game = {
      gameId, tier, coin, chain, decimals,
      stakeMinor: stakeMinor.toString(),
      escrowAddress, operatorAddress,
      // XRPL uses a persistent destination tag; other chains use
      // sender-address binding. Tags come from the store allocator so
      // a restart never reuses a tag.
      tag: chain === 'xrpl' ? String(storeImpl.nextTag()) : null,
      players: {
        white: { sender: whiteSender, payout: payout.white || whiteSender, deposited: false, depositTx: null },
        black: { sender: blackSender, payout: payout.black || blackSender, deposited: false, depositTx: null },
      },
      state: 'waiting_deposits',
      createdAt,
      deadlineAt: createdAt + timeoutMs,
      settlement: null,
      result: null,
    };
    persist(game);
    return {
      gameId, tier, coin, chain, decimals,
      stakeDisplay: tier + ' ' + coin,
      escrowAddress,
      destinationTag: game.tag, // null on non-XRPL chains (sender binding instead)
      depositDeadlineAt: game.deadlineAt,
      depositInstructions: chain === 'xrpl'
        ? `Send exactly ${tier} ${coin} to ${escrowAddress} with destination tag ${game.tag}.`
        : `Send exactly ${tier} ${coin} to ${escrowAddress} from your registered address (${chain === 'solana' ? 'token-account owner' : 'sender'}). No tag exists on this chain.`,
    };
  }

  function getGame(gameId) {
    const game = games.get(gameId);
    if (!game) throw new Error('unknown game: ' + gameId);
    return game;
  }

  function expectedFor(game, side) {
    const base = { to: game.escrowAddress, coin: game.coin, amountMinor: game.stakeMinor };
    if (game.chain === 'xrpl') return { ...base, tag: game.tag };
    return { ...base, sender: game.players[side].sender };
  }

  function recordDeposit(gameId, side, tx) {
    const game = getGame(gameId);
    if (!['white', 'black'].includes(side)) throw new Error('side must be white or black');
    if (game.state !== 'waiting_deposits') {
      return { ok: false, reason: 'game is not waiting for deposits (state: ' + game.state + ')' };
    }
    const player = game.players[side];
    if (player.deposited) {
      // Same transfer seen twice (watcher re-poll): not an error, and
      // never double-credits the side.
      if (tx.txHash && player.depositTx && player.depositTx.txHash === tx.txHash) {
        return { ok: false, reason: 'deposit already recorded' };
      }
      return { ok: false, reason: 'side already deposited' };
    }
    const mod = chainFor(game.chain);
    const check = mod.matchDeposit(tx, expectedFor(game, side));
    if (!check.ok) return { ok: false, reason: check.reason };
    player.deposited = true;
    player.depositTx = { txHash: tx.txHash || null, at: now() };
    if (game.players.white.deposited && game.players.black.deposited) game.state = 'playing';
    persist(game);
    return { ok: true, state: game.state };
  }

  // Find the waiting game a normalized watcher transfer belongs to.
  // XRPL: by destination tag. Other chains: by chain + coin + sender +
  // exact amount, oldest waiting game first (a player with two identical
  // open games is matched to the oldest; recordDeposit then locks it).
  function findGameForDeposit(chain, tx) {
    const candidates = [];
    for (const game of games.values()) {
      if (game.chain !== chain || game.state !== 'waiting_deposits') continue;
      if (chain === 'xrpl') {
        if (game.tag && String(tx.destinationTag) === String(game.tag)) candidates.push(game);
        continue;
      }
      const coin = tx.coin;
      if (game.coin !== coin) continue;
      if (BigInt(tx.amountMinor) !== BigInt(game.stakeMinor)) continue;
      const side = ['white', 'black'].find((s) =>
        !game.players[s].deposited &&
        String(game.players[s].sender).toLowerCase() === String(tx.from || tx.owner || '').toLowerCase());
      if (side) candidates.push({ game, side });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.game || a).createdAt - (b.game || b).createdAt);
    const hit = candidates[0];
    if (chain === 'xrpl') {
      // On XRPL the destination tag IS the binding (unique per game).
      // Prefer the side whose registered sender matches; otherwise the
      // first side that has not deposited yet. A deposit from an
      // unregistered address with the right tag still belongs to the
      // game — it is the tag, not the sender, that identifies it.
      const g = hit;
      const side = ['white', 'black'].find((s) =>
        !g.players[s].deposited &&
        (!tx.from || String(g.players[s].sender).toLowerCase() === String(tx.from).toLowerCase()))
        || ['white', 'black'].find((s) => !g.players[s].deposited);
      return side ? { game: g, side } : null;
    }
    return hit; // { game, side }
  }

  // result: { type: 'win', winner: 'white'|'black' } | { type: 'draw' } | { type: 'cancelled' }
  // IDEMPOTENT: a second settle on the same game returns the recorded
  // settlement with duplicate: true and pays nothing new.
  function settle(gameId, result, playerAddresses) {
    const game = getGame(gameId);
    if (game.settlement) {
      return { ...game.settlement, duplicate: true };
    }
    const mod = chainFor(game.chain);
    const calc = settlement.settleGame(BigInt(game.stakeMinor), result);
    const addr = {
      white: (playerAddresses && playerAddresses.white) || game.players.white.payout,
      black: (playerAddresses && playerAddresses.black) || game.players.black.payout,
      operator: game.operatorAddress,
    };
    const outputs = calc.outputs.map((o) => ({ to: addr[o.to], amountMinor: o.amountMinor.toString() }));
    const payloads = mod.buildSettlement(outputs, game.coin);
    const record = {
      gameId, coin: game.coin, chain: game.chain,
      result: result.type + (result.winner ? ':' + result.winner : ''),
      outputs, payloads, dust: calc.dust.toString(),
      txHashes: [], // filled in by the signer as payouts land on chain
      settledAt: now(),
      note: 'Payloads are UNSIGNED until the operator signer submits them. Settlement is recorded once — a repeat settle returns this record.',
    };
    game.settlement = record;
    game.result = record.result;
    game.state = result.type === 'cancelled' ? 'cancelled' : 'settled';
    persist(game);
    return { ...record, duplicate: false };
  }

  // Attach on-chain payout transaction hashes to a settled game.
  function recordSettlementTx(gameId, txHashes) {
    const game = getGame(gameId);
    if (!game.settlement) throw new Error('game has no settlement yet: ' + gameId);
    game.settlement.txHashes = txHashes;
    persist(game);
    return game.settlement;
  }

  // Cancel a game that never started and refund confirmed deposits in
  // full (settlement type 'cancelled' — operator gets nothing).
  function cancelGame(gameId, reason) {
    const game = getGame(gameId);
    if (game.settlement) return { ...game.settlement, duplicate: true };
    if (game.state !== 'waiting_deposits') {
      throw new Error('cannot cancel a game in state: ' + game.state);
    }
    const record = settle(gameId, { type: 'cancelled' });
    record.cancelReason = reason || 'deposit timeout';
    game.settlement.cancelReason = record.cancelReason;
    persist(game);
    return record;
  }

  // Cancel every deposit-waiting game past its deadline. Returns the
  // cancelled games with their refund settlements — the service loop
  // hands these to the signer so refunds actually go out.
  function sweepExpired(at) {
    const t = at || now();
    const cancelled = [];
    for (const game of games.values()) {
      if (game.state === 'waiting_deposits' && game.deadlineAt <= t) {
        cancelled.push(cancelGame(game.gameId, 'deposit timeout: both stakes did not land within 600s'));
      }
    }
    return cancelled;
  }

  function publicGame(gameId) {
    const g = getGame(gameId);
    return {
      gameId: g.gameId, tier: g.tier, coin: g.coin, chain: g.chain,
      decimals: g.decimals, stakeDisplay: g.tier + ' ' + g.coin,
      escrowAddress: g.escrowAddress, destinationTag: g.tag,
      state: g.state,
      players: {
        white: { deposited: g.players.white.deposited },
        black: { deposited: g.players.black.deposited },
      },
      createdAt: g.createdAt, deadlineAt: g.deadlineAt,
      result: g.result,
      settlement: g.settlement ? {
        result: g.settlement.result, outputs: g.settlement.outputs,
        dust: g.settlement.dust, txHashes: g.settlement.txHashes,
        settledAt: g.settlement.settledAt,
      } : null,
    };
  }

  return {
    games, // live Map (backwards-compatible with the old module shape)
    createStakeGame, recordDeposit, settle, cancelGame, sweepExpired,
    findGameForDeposit, recordSettlementTx, publicGame, getGame,
    tokenDecimals, chainFor, store: storeImpl,
  };
}

// Default instance: in-memory store, same exports as before so existing
// tests and callers keep working unchanged.
const defaultService = createGameService({ store: createMemoryStore() });

module.exports = {
  chains,
  games: defaultService.games,
  createStakeGame: defaultService.createStakeGame,
  recordDeposit: defaultService.recordDeposit,
  settle: defaultService.settle,
  cancelGame: defaultService.cancelGame,
  sweepExpired: defaultService.sweepExpired,
  findGameForDeposit: defaultService.findGameForDeposit,
  recordSettlementTx: defaultService.recordSettlementTx,
  publicGame: defaultService.publicGame,
  getGame: defaultService.getGame,
  tokenDecimals: defaultService.tokenDecimals,
  createGameService,
};
