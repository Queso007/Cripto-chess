/* Crypto Chess — payout service HTTP API (plain Node http).
 * Endpoints:
 *   GET  /health                     service + watcher + key status
 *   GET  /api/config                 public config (addresses, tiers, coins)
 *   POST /api/games                  create a stake game
 *   GET  /api/games/:id             game state + deposit status
 *   GET  /api/games/:id/deposits    deposit status per side
 *   GET  /api/games/:id/settlement  recorded settlement (if any)
 *   POST /api/games/:id/result      operator: report game result, settle + pay
 *   POST /api/games/:id/cancel      operator: cancel + refund + pay
 *   POST /api/games/:id/retry-payout operator: retry failed payouts
 *
 * Operator endpoints require the X-Operator-Token header matching
 * OPERATOR_API_TOKEN. If no token is configured, operator endpoints
 * refuse all calls (fail closed) — set the token in Render secrets.
 * Game creation is open: anyone can create a game, but a game only
 * pays out when BOTH deposits land in escrow and the operator (or the
 * game client reporting through the operator token) reports a result.
 */
'use strict';

const http = require('http');

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limitBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) reject(new Error('request body too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function createHttpServer({ service, signer, config }) {
  const startedAt = Date.now();

  function requireOperator(req) {
    const token = config.server.operatorApiToken;
    if (!token) return { ok: false, status: 503, error: 'operator endpoints disabled: OPERATOR_API_TOKEN is not configured' };
    if (req.headers['x-operator-token'] !== token) {
      return { ok: false, status: 401, error: 'invalid or missing X-Operator-Token' };
    }
    return { ok: true };
  }

  // Settle a game and pay out. Returns the settlement record; on
  // signer failure the settlement stays recorded with payoutPending
  // so the operator can retry via /retry-payout.
  async function settleAndPay(gameId, result) {
    const settlement = service.settle(gameId, result);
    if (settlement.duplicate) return { status: 200, body: { ...settlement, paid: settlement.txHashes.length > 0 } };
    try {
      const paid = await signer.sendPayouts({
        chain: settlement.chain, coin: settlement.coin, outputs: settlement.outputs,
      });
      service.recordSettlementTx(gameId, paid.txHashes);
      return { status: 200, body: { ...service.publicGame(gameId).settlement, paid: true, dryRun: paid.dryRun } };
    } catch (e) {
      console.error(`[http] payout failed for ${gameId}: ${e.message}`);
      return { status: 502, body: { ...settlement, payoutPending: true, payoutError: e.message } };
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    // CORS (single configured origin, or * for development).
    const origin = config.server.corsOrigin;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Operator-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (method === 'GET' && path === '/health') {
        const counts = {};
        for (const g of service.games.values()) counts[g.state] = (counts[g.state] || 0) + 1;
        return sendJson(res, 200, {
          ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          games: counts, keysConfigured: signer.verifyKeys(), dryRun: signer.dryRun,
        });
      }

      if (method === 'GET' && path === '/api/config') {
        return sendJson(res, 200, {
          escrow: config.escrow, operator: config.operator,
          tiers: config.tiers, tokens: config.tokens, finality: config.finality,
          depositTimeoutSec: config.depositTimeoutSec,
        });
      }

      if (method === 'POST' && path === '/api/games') {
        const body = await readBody(req);
        const { tier, coin, chain, whiteSender, blackSender, whitePayout, blackPayout } = body;
        if (!tier || !coin || !chain || !whiteSender || !blackSender) {
          return sendJson(res, 400, { error: 'tier, coin, chain, whiteSender, blackSender are required' });
        }
        const created = service.createStakeGame({
          tier: Number(tier), coin, chain, whiteSender, blackSender,
          escrowAddress: config.escrow[chain], operatorAddress: config.operator[chain],
          payoutAddresses: { white: whitePayout, black: blackPayout },
        });
        return sendJson(res, 201, created);
      }

      const gameMatch = path.match(/^\/api\/games\/([^/]+)(?:\/(deposits|settlement|result|cancel|retry-payout))?$/);
      if (gameMatch) {
        const [, gameId, action] = gameMatch;
        if (method === 'GET' && !action) {
          return sendJson(res, 200, service.publicGame(gameId));
        }
        if (method === 'GET' && action === 'deposits') {
          const g = service.getGame(gameId);
          return sendJson(res, 200, {
            gameId, state: g.state, deadlineAt: g.deadlineAt,
            white: { deposited: g.players.white.deposited },
            black: { deposited: g.players.black.deposited },
          });
        }
        if (method === 'GET' && action === 'settlement') {
          const g = service.getGame(gameId);
          if (!g.settlement) return sendJson(res, 404, { error: 'game has no settlement yet' });
          return sendJson(res, 200, g.settlement);
        }
        if (method === 'POST' && action === 'result') {
          const auth = requireOperator(req);
          if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
          const body = await readBody(req);
          if (!body.type || !['win', 'draw'].includes(body.type)) {
            return sendJson(res, 400, { error: "result type must be 'win' or 'draw'" });
          }
          if (body.type === 'win' && !['white', 'black'].includes(body.winner)) {
            return sendJson(res, 400, { error: "win requires winner 'white' or 'black'" });
          }
          const out = await settleAndPay(gameId, body);
          return sendJson(res, out.status, out.body);
        }
        if (method === 'POST' && action === 'cancel') {
          const auth = requireOperator(req);
          if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
          const settlement = service.cancelGame(gameId, 'cancelled by operator');
          if (settlement.duplicate) return sendJson(res, 200, { ...settlement, paid: settlement.txHashes.length > 0 });
          try {
            const paid = await signer.sendPayouts({
              chain: settlement.chain, coin: settlement.coin, outputs: settlement.outputs,
            });
            service.recordSettlementTx(gameId, paid.txHashes);
            return sendJson(res, 200, { ...service.publicGame(gameId).settlement, paid: true, dryRun: paid.dryRun });
          } catch (e) {
            console.error(`[http] refund failed for ${gameId}: ${e.message}`);
            return sendJson(res, 502, { ...settlement, payoutPending: true, payoutError: e.message });
          }
        }
        if (method === 'POST' && action === 'retry-payout') {
          const auth = requireOperator(req);
          if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
          const g = service.getGame(gameId);
          if (!g.settlement) return sendJson(res, 409, { error: 'game has no settlement to pay' });
          if (g.settlement.txHashes.length) {
            return sendJson(res, 200, { ...g.settlement, duplicate: true, paid: true });
          }
          try {
            const paid = await signer.sendPayouts({
              chain: g.settlement.chain, coin: g.settlement.coin, outputs: g.settlement.outputs,
            });
            service.recordSettlementTx(gameId, paid.txHashes);
            return sendJson(res, 200, { ...service.publicGame(gameId).settlement, paid: true, dryRun: paid.dryRun });
          } catch (e) {
            return sendJson(res, 502, { error: 'payout retry failed: ' + e.message, payoutPending: true });
          }
        }
      }

      return sendJson(res, 404, { error: 'not found: ' + method + ' ' + path });
    } catch (e) {
      if (e.message.startsWith('unknown game:')) return sendJson(res, 404, { error: e.message });
      if (e.message.startsWith('tier must be') || e.message.startsWith('coin ') || e.message.startsWith('unsupported chain')) {
        return sendJson(res, 400, { error: e.message });
      }
      console.error('[http] ' + e.stack);
      return sendJson(res, 500, { error: 'internal error: ' + e.message });
    }
  }

  const server = http.createServer(handle);
  return {
    server,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createHttpServer };
