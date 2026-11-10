> FLAT LAYOUT (2026-11-10): every file lives in this ONE folder — no `chains/` or `watchers/` subfolders. Upload all files in this folder into `crypto/server/` in a single GitHub upload. No `render.yaml` is used; create the Render web service manually from the dashboard (Root Directory `crypto/server`, Build `npm install`, Start `npm start`, Health Check `/health`, Plan Starter, Region Oregon).

# Crypto Chess — payout service

Chain watchers + operator signer that let real stablecoin stakes
auto-pay. Stablecoins only: **USDT, USDC, RLUSD**. Exact amounts, no
price conversion. Tiers **$5 / $10 / $20 / $40 / $100**.

> **Nothing here is deployed.** This code runs only when the operator
> deploys it to Render and sets the secrets in the Render dashboard.
> No real funds move until then.

## What it does

- **Watches all five chains** for deposits to the escrow addresses
  (TronGrid TRC-20 list + solidity re-confirmation, Solana RPC token
  deltas, EVM Transfer log scans, XRPL websocket + `account_tx`
  fallback) and matches them to games by token identity + exact
  amount + registered sender (or XRPL destination tag) + finality
  (Tron 20 blocks, Solana finalized, Polygon 128, Ethereum 12, XRPL
  validated ledger).
- **Settles idempotently**: a game pays once. A repeat settle returns
  the recorded settlement instead of paying twice. Dust is zero for
  all five whole-dollar tiers.
- **Refunds automatically**: if both stakes do not land within 600s,
  the game cancels and confirmed deposits are refunded in full
  (operator gets nothing).
- **Persists game records** to `DATA_DIR/games.json` so a process
  restart does not wipe live games (the xApp lesson). On Render's free
  plan the filesystem is ephemeral — attach the disk in `render.yaml`
  (paid plans) or a redeploy still wipes the file.
- **Orphan deposits** (transfers to escrow matching no waiting game)
  are logged loudly for manual reconciliation — they are never
  silently kept.

## Run locally (dry run — no keys, no funds)

```bash
cd crypto/server
npm install
npm test            # 26 settlement + 15 service tests, no network
DRY_RUN=true OPERATOR_API_TOKEN=dev-token npm start
curl localhost:3000/health
```

Dry-run mode returns the exact payout payloads without submitting
anything or touching a key. Use it for the first deploy check.

## API

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | status, game counts, keys configured (booleans only) |
| GET | `/api/config` | — | escrow/operator addresses, tiers, coins, finality |
| POST | `/api/games` | — | create game → deposit instructions (escrow + XRPL tag) |
| GET | `/api/games/:id` | — | game state + deposit status |
| GET | `/api/games/:id/deposits` | — | deposit status per side |
| GET | `/api/games/:id/settlement` | — | recorded settlement |
| POST | `/api/games/:id/result` | `X-Operator-Token` | report win/draw → settle + pay |
| POST | `/api/games/:id/cancel` | `X-Operator-Token` | cancel → refund + pay |
| POST | `/api/games/:id/retry-payout` | `X-Operator-Token` | retry a failed payout |

Create body: `{ tier, coin, chain, whiteSender, blackSender,
whitePayout?, blackPayout? }`. Payout addresses default to the
sender addresses. Result body: `{ type: 'win', winner: 'white'|'black' }`
or `{ type: 'draw' }`.

## Deploy to Render (operator checklist)

1. **Push this directory to the repo** (the Render service in
   `render.yaml` builds from `crypto/server`).
2. **Create the Web Service** in Render (or `render blueprint` with
   `render.yaml`): Node, build `npm install`, start `npm start`,
   health check `/health`.
3. **Set these secrets in the Render dashboard** (Environment >
   Environment Variables). Never paste them in chat, code, or docs:
   - `OPERATOR_API_TOKEN` — long random string; the game client sends
     it as `X-Operator-Token`. Operator endpoints refuse all calls
     while it is unset.
   - `OPERATOR_KEY_TRON` — hex private key.
   - `OPERATOR_KEY_SOLANA` — base58 secret key (Phantom export).
   - `OPERATOR_KEY_EVM` — 0x hex private key (Ethereum + Polygon).
   - `OPERATOR_KEY_XRPL` — family seed (`s...`).
4. **Fund the escrow wallets** (these are the only funding steps):
   - Each escrow wallet needs its chain's native gas token for
     settlement fees: TRX (Tron), SOL (Solana), ETH (Ethereum),
     POL (Polygon), XRP (XRPL — also the reserve).
   - Trust lines: the XRPL escrow wallet must trust Ripple's RLUSD
     issuer (`rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`); each player must
     trust it too to hold RLUSD.
   - The escrow wallets hold the stakes float (player deposits land
     there; payouts go out from there).
5. **Attach the disk** (paid plans) and set `DATA_DIR=/var/data` so
   game records survive restarts. On the free plan, do not redeploy
   while a stake game is in flight.
6. **Point the web build at the service**: set the game's API base URL
   to the Render service URL and send `X-Operator-Token` from the
   game client on result reports. (The static site currently plays
   pass & play only.)
7. **Small-amount test plan** (do this before opening real stakes):
   1. Deploy with `DRY_RUN=true` first; check `/health` shows
      `dryRun: true` and the right escrow addresses in `/api/config`.
   2. Create a $5 game on Tron (cheapest route); send both $5 USDT
      deposits from two wallets; confirm the game flips to `playing`.
   3. Report a win; with `DRY_RUN=true` confirm the settlement
      math in the response (winner 9.5, operator 0.5) and no
      transaction hash.
   4. Remove `DRY_RUN`, set the real keys, repeat the $5 game;
      confirm both payout transactions on Tronscan and the operator
      address receiving 0.5 USDT.
   5. Test the timeout path: create a $5 game, send only one
      deposit, wait 10 minutes, confirm the single deposit is
      refunded in full.
   6. Repeat steps 2–4 on one more chain (Solana is the next
      cheapest) before accepting stakes on all five.

## Files

- `config.js` — addresses, tokens, finality, RPC defaults, env overrides
- `store.js` — JSON file persistence + tag allocator
- `index.js` — game flow: create / deposit / settle (idempotent) / sweep
- `settlement.js` — settlement math (single source of truth, do not
  change economics here)
- `signer.js` — operator signer (env keys only, dry-run mode)
- `http.js` — HTTP API (plain Node http)
- `server.js` — entry point: wires store + service + signer + watchers
- `watchers/` — Tron / Solana / EVM / XRPL deposit watchers + RPC helper
- `settlement.test.js` — 26 settlement + matching tests
- `server.test.js` — 15 service tests (config, store, idempotency,
  sweep, watcher normalizers, signer, HTTP API)
