/* Crypto Chess — watcher RPC helpers (shared).
 * Plain fetch + JSON-RPC with timeouts. No API keys are needed for the
 * default public endpoints; where a provider key exists it is passed in
 * as a header by the caller, never baked in here.
 */
'use strict';

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let nextRpcId = 1;
async function jsonRpc(url, method, params = [], { timeoutMs = 15000, headers = {} } = {}) {
  const payload = { jsonrpc: '2.0', id: nextRpcId++, method, params };
  const out = await fetchJson(url, { method: 'POST', headers, body: payload, timeoutMs });
  if (out.error) throw new Error(`RPC ${method} error: ${out.error.message || JSON.stringify(out.error)}`);
  return out.result;
}

module.exports = { fetchJson, jsonRpc };
