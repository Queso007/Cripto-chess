/* Crypto Chess — payout service configuration.
 * Single source of truth for the server: escrow + operator addresses,
 * accepted tokens, finality thresholds, RPC endpoints, and the deposit
 * window. Every value below can be overridden by environment variable
 * (see .env.example) — the defaults are the production values agreed
 * with the operator on 2026-11-04.
 *
 * NO SECRETS IN THIS FILE. Operator keys live ONLY in environment
 * variables (OPERATOR_KEY_TRON / _SOLANA / _EVM / _XRPL), set in the
 * Render dashboard, never in code, config, or docs.
 *
 * Stablecoins ONLY: USDT, USDC, RLUSD. Exact amounts, no price
 * conversion. Tiers $5 / $10 / $20 / $40 / $100.
 */
'use strict';

const ESCROW_DEFAULTS = {
  tron: 'TBgET9wfANqaUFbA1PMGuok2NmRMVVRsoz',
  solana: '6h9vjU9RjsKGFMAE4y1PYSirytRc4oZJ3YZc5cgJ1KQm',
  ethereum: '0xA527Dbf12329D45E4E296d75C1983bA23AAf5570',
  polygon: '0xA527Dbf12329D45E4E296d75C1983bA23AAf5570',
  xrpl: 'rPJYyWys3Q3DhR2bTZf8NhzmfVFPoizMRn',
};

const OPERATOR_DEFAULTS = {
  tron: 'TGrGfLCtsuwjGyL5ooivNpqjbBpZDC4s34',
  solana: '7wquMQLyAE3bmPiJS4hznZmSYn6f9USRqSdLfn1ZTxkH',
  ethereum: '0x76ae8ee24a9D053439530F83bd152ed50b677Beb',
  polygon: '0x76ae8ee24a9D053439530F83bd152ed50b677Beb',
  xrpl: 'rn4ZbrXPMCEPrufA6QLGsBfwu7nsw3PmUm',
};

// Public RPC endpoints that need no API key. The operator may override
// any of them with a dedicated provider (Infura/Alchemy/Helius/QuickNode)
// via env for higher rate limits.
const RPC_DEFAULTS = {
  // TronGrid public endpoints (no key for low-rate use; set
  // TRONGRID_API_KEY for higher limits — it is sent as a header only).
  tronFullNode: 'https://api.trongrid.io',
  tronSolidityNode: 'https://api.trongrid.io',
  // Solana public RPC (rate-limited; set SOLANA_RPC_URL to a paid
  // endpoint for production volume).
  solanaRpc: 'https://api.mainnet-beta.solana.com',
  // PublicNode EVM endpoints (no key).
  ethereumRpc: 'https://ethereum.publicnode.com',
  polygonRpc: 'https://polygon-bor-rpc.publicnode.com',
  // XRPL public cluster (websocket + JSON-RPC).
  xrplWs: 'wss://xrplcluster.com',
  xrplRpc: 'https://xrplcluster.com',
};

const FINALITY = {
  tron: 20, // confirmed (solidity) blocks
  solana: 'finalized',
  polygon: 128, // blocks
  ethereum: 12, // blocks
  xrpl: 'validated', // validated ledger
};

const TOKENS = {
  tron: { USDT: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 } },
  solana: { USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } },
  ethereum: {
    USDT: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    RLUSD: { contract: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', decimals: 18 },
  },
  polygon: {
    // Native Circle USDC ONLY. Bridged USDC.e
    // (0x2791bca1f2de4661ed88a30c99a7a9449aa84174) is a different asset
    // and is rejected by the chain module's contract check.
    USDC: { contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  },
  xrpl: { RLUSD: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', decimals: 6 } },
};

const TIERS = [5, 10, 20, 40, 100];
const DEPOSIT_TIMEOUT_SEC = 600;

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function loadConfig(overrides = {}) {
  const escrow = {};
  const operator = {};
  for (const chain of Object.keys(ESCROW_DEFAULTS)) {
    escrow[chain] = env('ESCROW_' + chain.toUpperCase(), ESCROW_DEFAULTS[chain]);
    operator[chain] = env('OPERATOR_' + chain.toUpperCase(), OPERATOR_DEFAULTS[chain]);
  }
  return {
    escrow,
    operator,
    tokens: TOKENS,
    finality: FINALITY,
    tiers: TIERS,
    depositTimeoutSec: Number(env('DEPOSIT_TIMEOUT_SEC', DEPOSIT_TIMEOUT_SEC)),
    rpc: {
      tronFullNode: env('TRON_FULL_NODE', RPC_DEFAULTS.tronFullNode),
      tronSolidityNode: env('TRON_SOLIDITY_NODE', RPC_DEFAULTS.tronSolidityNode),
      tronGridApiKey: env('TRONGRID_API_KEY', ''),
      solanaRpc: env('SOLANA_RPC_URL', RPC_DEFAULTS.solanaRpc),
      ethereumRpc: env('ETHEREUM_RPC_URL', RPC_DEFAULTS.ethereumRpc),
      polygonRpc: env('POLYGON_RPC_URL', RPC_DEFAULTS.polygonRpc),
      xrplWs: env('XRPL_WS_URL', RPC_DEFAULTS.xrplWs),
      xrplRpc: env('XRPL_JSON_RPC', RPC_DEFAULTS.xrplRpc),
    },
    poll: {
      // Watcher poll intervals (ms). XRPL also keeps a live websocket
      // subscription; the poll is its fallback.
      tronMs: Number(env('POLL_TRON_MS', 15000)),
      solanaMs: Number(env('POLL_SOLANA_MS', 15000)),
      evmMs: Number(env('POLL_EVM_MS', 15000)),
      xrplMs: Number(env('POLL_XRPL_MS', 30000)),
      sweepMs: Number(env('SWEEP_MS', 30000)),
    },
    server: {
      port: Number(env('PORT', 3000)),
      host: env('HOST', '0.0.0.0'),
      corsOrigin: env('CORS_ORIGIN', '*'),
      operatorApiToken: env('OPERATOR_API_TOKEN', ''),
      dataDir: env('DATA_DIR', './data'),
    },
    ...overrides,
  };
}

module.exports = {
  ESCROW_DEFAULTS,
  OPERATOR_DEFAULTS,
  RPC_DEFAULTS,
  FINALITY,
  TOKENS,
  TIERS,
  DEPOSIT_TIMEOUT_SEC,
  loadConfig,
};
