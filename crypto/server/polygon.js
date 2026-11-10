/* Crypto Chess — Polygon PoS escrow module (USDC only in v1).
 * Native Circle USDC ONLY. The bridged USDC.e contract
 * (0x2791bca1f2de4661ed88a30c99a7a9449aa84174) reports the same symbol
 * but is a different asset and is REJECTED by the contract check.
 * Low fees; 128 confirmations is the operator-chosen default.
 */
'use strict';
const { makeEvmChain } = require('./evm');

module.exports = makeEvmChain({
  id: 'polygon',
  label: 'Polygon PoS',
  chainId: 137,
  tokens: {
    USDC: { contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  },
  confirmationsRequired: 128,
  rpcEnv: 'POLYGON_RPC_URL',
  explorer: 'https://polygonscan.com',
});
