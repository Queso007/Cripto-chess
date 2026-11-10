/* Crypto Chess — Ethereum escrow module (USDT + RLUSD).
 * Offered for completeness; Ethereum gas fees are expensive compared with
 * Tron/Solana/Polygon, so these routes are NOT recommended for small tiers.
 * RLUSD here uses 18 decimals (per Ripple's ERC-20 proxy docs) while USDT
 * uses 6 — the settlement math uses each token's own decimals.
 */
'use strict';
const { makeEvmChain } = require('./evm');

module.exports = makeEvmChain({
  id: 'ethereum',
  label: 'Ethereum',
  chainId: 1,
  tokens: {
    USDT: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    RLUSD: { contract: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', decimals: 18 },
  },
  confirmationsRequired: 12,
  rpcEnv: 'ETHEREUM_RPC_URL',
  explorer: 'https://etherscan.io',
});
