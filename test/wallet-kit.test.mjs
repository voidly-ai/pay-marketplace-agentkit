import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentKit } from '@coinbase/agentkit';
import { createVoidpayMarketplaceWalletKitActionProvider } from '../dist/index.js';

const listingId = 'svc_0123456789';
const quoteId = `0x${'a'.repeat(64)}`;
const buy = { listingId, version: 2, input: { query: 'one bounded call' } };
const listing = {
  name: 'Example', description: 'One paid example', category: 'analysis',
  upstreamUrl: 'https://seller.example.com/service', method: 'POST', priceAtomic: 1000000,
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
};
const noWallet = new Proxy({ getNetwork: () => ({ protocolFamily: 'evm', networkId: 'base-sepolia', chainId: '84532' }) },
  { get(target, key) { if (key in target) return target[key]; throw new Error(`host wallet touched: ${String(key)}`); } });
const actions = provider => Object.fromEntries(provider.getActions(noWallet).map(action => [action.name, action]));
const invoke = async (provider, action, input) =>
  JSON.parse(await actions(provider)[`VoidpayMarketplaceActionProvider_wallet_${action}`].invoke(input));
const host = overrides => ({
  walletKitVersion: '0.2.0', network: 'base-sepolia',
  perCallUsd: '2', dailyUsd: '5', maxUsd: '1',
  authorize: async () => ({}),
  executeBuy: async () => ({ command: 'buy', network: 'base-sepolia', listingId, version: 2,
    receiptVerified: true, verifiedStatus: 'delivered', doNotRepay: true,
    bodyComplete: true, quoteId, receipt: 'private-receipt', bodyUtf8: 'private-body' }),
  executeSell: async () => ({ command: 'sell', network: 'base-sepolia', status: 'pending_activation',
    listingId, version: 1, secretFile: '/private/never-output', hmacSecretHex: 'secret' }),
  ...overrides,
});

test('opt-in AgentKit host registers two commerce actions without touching the AgentKit wallet or network', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests.push(args); throw new Error('unexpected network'); };
  try {
    const provider = createVoidpayMarketplaceWalletKitActionProvider(host());
    const kit = await AgentKit.from({ walletProvider: noWallet, actionProviders: [provider] });
    assert.equal(kit.getActions().length, 7);
    assert.equal(requests.length, 0);
    assert.deepEqual(Object.keys(actions(provider)).slice(-2), [
      'VoidpayMarketplaceActionProvider_wallet_buy', 'VoidpayMarketplaceActionProvider_wallet_sell',
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test('buy validates the model selection and host caps, approves the exact frozen intent, executes once and redacts output', async () => {
  const calls = [];
  const permit = {};
  const provider = createVoidpayMarketplaceWalletKitActionProvider(host({
    authorize: async intent => { calls.push(['approve', intent]); return permit; },
    executeBuy: async (intent, receivedPermit) => {
      calls.push(['buy', intent, receivedPermit]);
      return { command: 'buy', network: 'base-sepolia', listingId, version: 2,
        receiptVerified: true, verifiedStatus: 'delivered', doNotRepay: true,
        bodyComplete: true, quoteId, receipt: 'private-receipt', bodyUtf8: 'private-body' };
    },
  }));
  assert.deepEqual(await invoke(provider, 'buy', buy), {
    status: 'delivered', receiptVerified: true, refundOwed: false, doNotRepay: true,
    bodyComplete: true, quoteId, recoverWith: 'wallet_recover_marketplace',
  });
  assert.deepEqual(calls.map(call => call[0]), ['approve', 'buy']);
  assert.equal(calls[1][1], calls[0][1]);
  assert.equal(calls[1][2], permit);
  assert.ok(Object.isFrozen(calls[0][1]));
  assert.ok(Object.isFrozen(calls[0][1].input));
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { kind: 'buy', network: 'base-sepolia',
    listingId, version: 2, input: buy.input, perCallUsd: '2', dailyUsd: '5', maxUsd: '1' });
  assert.deepEqual(await invoke(provider, 'buy', buy), { error: { code: 'INVALID_WALLET_PERMIT' } });
  assert.equal(calls.filter(call => call[0] === 'buy').length, 1);
});

test('denial and malformed model data never execute a wallet action', async () => {
  let approvals = 0;
  let executions = 0;
  const provider = createVoidpayMarketplaceWalletKitActionProvider(host({
    authorize: async () => { approvals++; return null; },
    executeBuy: async () => { executions++; throw new Error('must not execute'); },
  }));
  assert.deepEqual(await invoke(provider, 'buy', { ...buy, network: 'base' }),
    { error: { code: 'INVALID_INPUT' } });
  assert.deepEqual(await invoke(provider, 'buy', { ...buy, input: { get query() { throw new Error('getter'); } } }),
    { error: { code: 'INVALID_INPUT' } });
  assert.deepEqual(await invoke(provider, 'buy', buy), { error: { code: 'OWNER_APPROVAL_REQUIRED' } });
  assert.equal(approvals, 1);
  assert.equal(executions, 0);
});

test('uncertain payment preserves the original quote and never retries or discloses wallet errors', async () => {
  let executions = 0;
  const provider = createVoidpayMarketplaceWalletKitActionProvider(host({
    executeBuy: async () => {
      executions++;
      throw Object.assign(new Error('private payment details'),
        { paymentMayHaveSettled: true, quoteId, secret: 'never output' });
    },
  }));
  assert.deepEqual(await invoke(provider, 'buy', buy), {
    status: 'payment_uncertain', paymentMayHaveSettled: true, doNotRepay: true,
    quoteId, recoverWith: 'wallet_recover_marketplace',
  });
  assert.equal(executions, 1);
});

test('verified payment with an incomplete body requires original-attempt recovery, not a delivered claim', async () => {
  let executions = 0;
  const provider = createVoidpayMarketplaceWalletKitActionProvider(host({
    executeBuy: async () => {
      executions++;
      return { command: 'buy', network: 'base-sepolia', listingId, version: 2,
        receiptVerified: true, verifiedStatus: 'delivered', refundOwed: false,
        doNotRepay: true, bodyComplete: false, quoteId,
        recoveryCommand: `voidly-agent-wallet recover ${quoteId} --network base-sepolia`,
        recoveryHint: 'Paid response output is incomplete',
        receipt: 'private-receipt', bodyUtf8: 'incomplete private body' };
    },
  }));
  assert.deepEqual(await invoke(provider, 'buy', buy), {
    status: 'delivery_incomplete', receiptVerified: true, refundOwed: false,
    doNotRepay: true, bodyComplete: false, quoteId,
    recoverWith: 'wallet_recover_marketplace',
  });
  assert.equal(executions, 1);
});

test('seller creation reports pending activation only and hides HMAC secret and private path', async () => {
  let approved;
  const provider = createVoidpayMarketplaceWalletKitActionProvider(host({
    authorize: async intent => { approved = intent; return {}; },
  }));
  assert.deepEqual(await invoke(provider, 'sell', { listing }), {
    status: 'pending_activation', network: 'base-sepolia', listingId,
    version: 1, activationRequired: true,
  });
  assert.equal(approved.kind, 'sell');
  assert.equal(approved.network, 'base-sepolia');
  assert.ok(Object.isFrozen(approved.listing));
});

test('invalid host results and unknown failures do not claim delivery or a live listing', async () => {
  const badBuy = createVoidpayMarketplaceWalletKitActionProvider(host({
    executeBuy: async () => ({ command: 'buy', verifiedStatus: 'delivered' }),
  }));
  assert.deepEqual(await invoke(badBuy, 'buy', buy), { error: { code: 'INVALID_WALLET_RESULT' } });
  const badSell = createVoidpayMarketplaceWalletKitActionProvider(host({
    executeSell: async () => { throw Object.assign(new Error('private path'),
      { code: 'seller_creation_uncertain', secretFile: '/private/path' }); },
  }));
  assert.deepEqual(await invoke(badSell, 'sell', { listing }), {
    status: 'seller_creation_uncertain', doNotRetry: true, reconciliationRequired: true,
  });
  const wrongNetwork = createVoidpayMarketplaceWalletKitActionProvider(host({
    executeSell: async () => ({ command: 'sell', network: 'base', status: 'pending_activation',
      listingId, version: 1 }),
  }));
  assert.deepEqual(await invoke(wrongNetwork, 'sell', { listing }),
    { error: { code: 'INVALID_WALLET_RESULT' } });
});
