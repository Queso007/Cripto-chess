# Custody and Security Write-up — XRP Chess xApp (DRAFT FOR USER REVIEW, NOT SENT TO XRPL LABS)

Prepared 2026-11-04 for ticket #110348 (Crypto Ties LLC), in response to XRPL Labs' 2026-11-04 request for a careful review of the security, custody arrangements, and associated risks for custodial XRP stakes. This draft is built only from established facts about the live app; bracketed items need the user's confirmation before it is sent.

## 1. What is custodial here, in plain terms

- Players do not play directly against each other on-ledger. Each player sends their stake to a single operator-controlled escrow wallet on the XRP Ledger before the game starts.
- Stakes: Beginners 5 XRP (15+10), Professional 25 XRP (10+5), Master 100 XRP (5+3). Both players stake the same amount.
- Settlement: the winner keeps their own stake plus 90% of the loser's stake; 10% of the loser's stake goes to the operator wallet. On a draw, 5% of each player's stake goes to the operator and the rest is returned.
- A game that never starts — silence in WAITING/DEPOSITING, or the 600-second deposit deadline passing — cancels and deposits are refunded in full.
- A playing game ends only on checkmate, resignation, draw, or the chess clock flagging. Disconnecting during play does not forfeit the game (the clock keeps running, so a disconnected player can still lose on time).
- This is custodial by design: players must trust the operator to hold stakes and pay out correctly. That trust, and its limits, are disclosed in the published Terms of Service, with the custodial disclosure prominent.

## 2. Wallets and key control

- Escrow wallet: the operator's second wallet, `r4iQKY2Ni8jJLvnYrhrKQxyknpEDQZd5vU` (funded with 50 XRP on 2026-10-19; it is also the wallet that minted the Crypto Ties Genesis NFT).
- Operator wallet: the operator's main wallet, which receives the operator's share of settlements.
- No escrow seed, secret, or private key is stored in the app code or in the public repository. Payouts are signed automatically by the backend server: when a game ends, the server builds the escrow wallet from its seed and submits one XRPL Payment per payout, waiting for ledger validation. The seed is held as a Render environment variable (ESCROW_SEED) set manually in the Render dashboard — it is not in the app code, the public repository, or the Render blueprint. Payouts are not manual sends signed in Xaman; manual Xaman sends are only how players send their stakes in.
- XRPL deposit matching uses destination tags, a ledger-native feature, to link a deposit to the right game.
- Payout timing: payouts are submitted immediately when the game ends and normally validate on the ledger within seconds; the game-over screen shows each payout's transaction hash. If a submission fails, the settlement is flagged to the players (not silently dropped) and retried when the game page next polls. If a payout is delayed or disputed, contact support at https://xrp-chess.netlify.app/#support.

## 3. What the server does and does not do

- The backend validates moves, runs matchmaking and the lobby, watches for deposits, and tracks game state. Game state is held in memory: a backend redeploy wipes live in-memory games, so redeploys are done only when no game is running.
- Funds themselves live on the XRP Ledger in the escrow wallet, not in the app's memory — a redeploy does not move or erase ledger funds.
- The rake stays in escrow and is swept manually; there is no automatic rake transaction.
- Manual payment via the escrow address plus destination tag is the proven payout path; the in-app Pay button was removed because it never worked end to end.
- The app collects no analytics product (no Google Analytics, Plausible, Sentry, or similar in the frontend or backend). Hosting and third-party data collection (Render, Netlify, script CDNs, XRPL public nodes, Xaman API) are disclosed in the published Privacy Policy.

## 4. Risks, stated plainly

- Single-operator custody: if the operator wallet is lost, compromised, or unavailable, stakes held in escrow may be delayed or unrecoverable. There is no third-party custodian, no multisig, and no insurance established for these funds — do not claim any of those unless they are actually put in place.
- Counterparty risk: players rely on the operator to pay the winner and refund cancelled games. The published Terms disclose this custodial arrangement.
- Game-state risk: a server restart or redeploy during a game loses the in-memory game record; deposits already on the ledger remain traceable by destination tag, but the game itself would need operator handling.
- Smart-contract risk does not apply in the usual sense: there is no on-ledger escrow contract holding these stakes — custody is a wallet controlled by the operator, not a contract.
- Regulatory risk (noted, not resolved by this document): real-money gaming compliance in Pennsylvania remains open and should be sorted before real players stake real money at scale.

## 5. What is still open

- OTT login: backend-first frontend fix uploaded 2026-11-04 (index.html, app.py, xaman.py to the repo root); in-Xaman test passed the same day — the xApp loaded without signing in again. Backend route re-check is pending on the agent side, but the user-facing OTT login (no additional login) is confirmed.
- Small-screen testing on iOS and Android, including smaller screens, is not yet confirmed.
- README forfeit wording: the user is editing lines 75, 85, and 107 to match live behaviour; other lines mentioning forfeit / ABANDON_TIMEOUT_SEC=90 still need a consistency check after that edit.
- This write-up itself: complete — signing confirmed from the code and the Render dashboard, timing from the code, dispute contact confirmed as the published support page. Ready to send once the small-screen and README items are also complete, per Mai's 2026-11-04 instruction.
