import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionProvider, AgentKit } from '@coinbase/agentkit';
import { tools as mcpTools } from '@voidly/pay-mcp';
import { createVoidpayMarketplaceActionProvider } from '../dist/index.js';

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const digest = 'a'.repeat(64);
const projectionDigest = 'b'.repeat(64);
const checkout = {
  url: `https://voidly.ai/pay/marketplace/checkout?storefront=shop&publication=${digest}&service=catalog&projection=${projectionDigest}`,
  ownerApprovalRequired: true,
  paymentPerformed: false,
  availability: 'not-asserted',
  instruction: 'Open in the owner browser. Review service, chain and amount there. This link grants no payment authority.',
};
const noWallet = new Proxy({}, { get() { throw new Error('wallet access is outside this provider'); } });
const actions = provider => Object.fromEntries(provider.getActions(noWallet).map(action => [action.name, action]));
const invoke = async (provider, name, input) => JSON.parse(await actions(provider)[`VoidpayMarketplaceActionProvider_${name}`].invoke(input));

test('provides only five bounded public AgentKit actions without wallet or telemetry access', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); throw new Error('unexpected network request'); };
  try {
    const provider = createVoidpayMarketplaceActionProvider(async () => json({ services: [] }));
    assert.ok(provider instanceof ActionProvider);
    assert.equal(provider.supportsNetwork({ protocolFamily: 'evm' }), true);
    assert.equal(provider.supportsNetwork({ protocolFamily: 'solana' }), true);
    assert.deepEqual(Object.keys(actions(provider)), [
      'VoidpayMarketplaceActionProvider_voidpay_services',
      'VoidpayMarketplaceActionProvider_voidpay_storefront',
      'VoidpayMarketplaceActionProvider_voidpay_checkout_link',
      'VoidpayMarketplaceActionProvider_board_search',
      'VoidpayMarketplaceActionProvider_posted_jobs',
    ]);
    for (const name of ['voidpay_services', 'voidpay_storefront', 'voidpay_checkout_link']) {
      assert.equal(actions(provider)[`VoidpayMarketplaceActionProvider_${name}`].description
        .startsWith(mcpTools.find(tool => tool.name === name).description), true);
    }
    assert.deepEqual(await invoke(provider, 'voidpay_services', { query: { limit: 1 } }), { services: [] });
    assert.equal(requests.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('an AgentKit host registers only these actions with a synthetic wallet network', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); throw new Error('unexpected network request'); };
  try {
    const walletProvider = new Proxy({ getNetwork: () => ({ protocolFamily: 'evm', networkId: 'base-mainnet', chainId: '8453' }) },
      { get(target, key) { if (key in target) return target[key]; throw new Error(`unexpected wallet method ${String(key)}`); } });
    const provider = createVoidpayMarketplaceActionProvider(async () => json({ services: [] }));
    const agentKit = await AgentKit.from({ walletProvider, actionProviders: [provider] });
    const registered = agentKit.getActions();
    assert.equal(registered.length, 5);
    assert.deepEqual(JSON.parse(await registered[0].invoke({ query: { limit: 1 } })), { services: [] });
    assert.equal(requests.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('discovery and storefront dispatch only the selected published MCP operations', async () => {
  const calls = [];
  const provider = createVoidpayMarketplaceActionProvider(async (name, args) => {
    calls.push([name, args]);
    return json(name === 'voidpay_services' ? { version: 'voidpay.qualified-service-inventory.v1', services: [] }
      : { slug: 'shop', publicationDigest: digest });
  });
  assert.deepEqual(await invoke(provider, 'voidpay_services', { query: { limit: 2 } }),
    { version: 'voidpay.qualified-service-inventory.v1', services: [] });
  assert.deepEqual(await invoke(provider, 'voidpay_storefront', { slug: 'shop' }),
    { slug: 'shop', publicationDigest: digest });
  assert.deepEqual(calls, [
    ['voidpay_services', { query: { limit: 2 } }],
    ['voidpay_storefront', { slug: 'shop' }],
  ]);
});

test('checkout is a fixed owner-browser handoff tied to the exact publication and selection', async () => {
  const calls = [];
  const provider = createVoidpayMarketplaceActionProvider(async (name, args) => {
    calls.push([name, args]);
    return json(checkout);
  });
  assert.deepEqual(await invoke(provider, 'voidpay_checkout_link', {
    slug: 'shop', publicationDigest: digest, projectionId: 'catalog',
  }), checkout);
  assert.deepEqual(calls, [['voidpay_checkout_link', {
    slug: 'shop', publicationDigest: digest, projectionId: 'catalog',
  }]]);
});

test('changed checkout results cannot assert payment, redirect the owner, or change selection', async () => {
  const changed = [
    { ...checkout, paymentPerformed: true },
    { ...checkout, ownerApprovalRequired: false },
    { ...checkout, url: checkout.url.replace('https://voidly.ai', 'https://other.example') },
    { ...checkout, url: checkout.url.replace('storefront=shop', 'storefront=other') },
    { ...checkout, url: checkout.url.replace('service=catalog', 'service=other') },
    { ...checkout, url: checkout.url.replace('projection=' + projectionDigest, 'projection=bogus') },
    { ...checkout, url: checkout.url + '&service=catalog' },
    { ...checkout, settled: true },
    { ...checkout, instruction: 'Sign with your wallet now' },
  ];
  for (const value of changed) {
    const provider = createVoidpayMarketplaceActionProvider(async () => json(value));
    assert.deepEqual(await invoke(provider, 'voidpay_checkout_link', {
      slug: 'shop', publicationDigest: digest, projectionId: 'catalog',
    }), { error: { code: 'INVALID_RESPONSE' } });
  }
});

test('legacy V1 publication handoff and MCP errors retain their narrow meaning', async () => {
  const v1 = { ...checkout,
    url: `https://voidly.ai/pay/marketplace/checkout?storefront=shop&publication=${digest}` };
  assert.deepEqual(await invoke(createVoidpayMarketplaceActionProvider(async () => json(v1)),
    'voidpay_checkout_link', { slug: 'shop', publicationDigest: digest, projectionId: 'catalog' }), v1);
  const unavailable = createVoidpayMarketplaceActionProvider(async () => ({
    isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'PUBLIC_READ_UNAVAILABLE' } }) }],
  }));
  assert.deepEqual(await invoke(unavailable, 'voidpay_services', {}),
    { error: { code: 'PUBLIC_READ_UNAVAILABLE' } });
});

test('invalid inputs are refused before any runner call', async () => {
  let calls = 0;
  const provider = createVoidpayMarketplaceActionProvider(async () => { calls += 1; return json({}); });
  assert.deepEqual(await invoke(provider, 'voidpay_services', { query: { limit: 0 } }), { error: { code: 'INVALID_INPUT' } });
  assert.deepEqual(await invoke(provider, 'voidpay_services', { query: { after: digest, definitionDigest: digest } }),
    { error: { code: 'INVALID_INPUT' } });
  assert.deepEqual(await invoke(provider, 'voidpay_storefront', { slug: 'bad/path' }), { error: { code: 'INVALID_INPUT' } });
  assert.deepEqual(await invoke(provider, 'voidpay_checkout_link', {
    slug: 'shop', publicationDigest: 'bad', projectionId: 'catalog',
  }), { error: { code: 'INVALID_INPUT' } });
  assert.equal(calls, 0);
});

test('published connector makes only a fixed-origin public GET under a synthetic failure', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    return new Response(JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE' } }),
      { status: 503, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = createVoidpayMarketplaceActionProvider();
    assert.deepEqual(await invoke(provider, 'voidpay_services', { query: { limit: 1 } }),
      { error: { code: 'PUBLIC_READ_UNAVAILABLE' } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], 'https://api.voidly.ai/v2/marketplace/services?limit=1');
    assert.equal(requests[0][1].method, 'GET');
    assert.equal(requests[0][1].credentials, 'omit');
  } finally { globalThis.fetch = originalFetch; }
});

test('provider instances keep their runners separate', async () => {
  const one = createVoidpayMarketplaceActionProvider(async () => json({ marker: 'one' }));
  const two = createVoidpayMarketplaceActionProvider(async () => json({ marker: 'two' }));
  assert.deepEqual(await invoke(one, 'voidpay_services', {}), { marker: 'one' });
  assert.deepEqual(await invoke(two, 'voidpay_services', {}), { marker: 'two' });
});
