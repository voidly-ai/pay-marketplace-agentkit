import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoidpayMarketplaceActionProvider } from '../dist/index.js';

const provider = () => createVoidpayMarketplaceActionProvider(async () => {
  throw new Error('the connector is outside these public reads');
});
const noWallet = new Proxy({}, { get() { throw new Error('wallet access is outside this provider'); } });
const invoke = async (name, input) => {
  const action = provider().getActions(noWallet).find(item => item.name.endsWith(`_${name}`));
  assert.ok(action);
  return JSON.parse(await action.invoke(input));
};
const response = value => Response.json(value);
const payment = {
  chainId: 8453, asset: 'USDC', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6, paymentMode: 'manual-after-review-direct-wallet-transfer',
  fundsReserved: false, balanceVerified: false, automaticPayouts: false, escrowProvided: false,
};
const posted = (jobId, status = 'published') => ({
  jobId, terms: { title: 'Map review', brief: 'Review a public map', deliverables: ['Short note'],
    acceptanceCriteria: ['Source link'], rewardAtoms: '1000000', suggestedTimeboxMinutes: 45 },
  status, claimsAvailable: status === 'published', publishedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_604_800_000, ...payment,
  payerAddress: 'private-canary', ownerEmail: 'private-canary', paymentStatus: 'paid',
});
const boardPost = {
  id: '11111111-1111-4111-8111-111111111111', board: 'market-general',
  author_did: 'did:voidly:SynthBoardSeven', author_affiliation: 'voidly_agent',
  title: 'Welcome', body: 'Ask about the marketplace', tags: ['help'],
  reply_to: null, created_at: '2026-10-06T12:00:00.000Z',
  listing_url: 'https://untrusted.example/pay', private_token: 'private-canary',
};

test('board search uses one fixed anonymous GET and projects only public post fields', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    return response({ posts: [boardPost], next_cursor: null, private_token: 'private-canary' });
  };
  try {
    const result = await invoke('board_search', { board: 'market-general', q: 'market', limit: 2 });
    assert.deepEqual(result, {
      posts: [{ id: boardPost.id, board: 'market-general', authorDid: boardPost.author_did,
        authorAffiliation: 'Voidly agent', title: 'Welcome', body: boardPost.body,
        tags: ['help'], createdAt: boardPost.created_at }],
      nextCursor: null, searchScope: 'one-public-page', publicContent: true,
      listingLinksVerified: false,
    });
    assert.equal(JSON.stringify(result).includes('private-canary'), false);
    assert.equal(JSON.stringify(result).includes('untrusted.example'), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], 'https://api.voidly.ai/v1/agent/board/posts?limit=2&board=market-general&q=market');
    assert.equal(requests[0][1].method, 'GET');
    assert.equal(requests[0][1].credentials, 'omit');
    assert.equal(requests[0][1].redirect, 'manual');
    assert.equal(requests[0][1].cache, 'no-store');
    assert.deepEqual(requests[0][1].headers, { Accept: 'application/json' });
  } finally { globalThis.fetch = original; }
});

test('board search accepts Unicode title and body within the board string-length limits', async () => {
  const original = globalThis.fetch;
  const title = '界'.repeat(41);
  const body = '界'.repeat(1_334);
  assert.equal(title.length, 41);
  assert.equal(Buffer.byteLength(title, 'utf8'), 123);
  assert.equal(body.length, 1_334);
  assert.equal(Buffer.byteLength(body, 'utf8'), 4_002);
  globalThis.fetch = async () => response({ posts: [{ ...boardPost, title, body }], next_cursor: null });
  try {
    const result = await invoke('board_search', { limit: 1 });
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].title, title);
    assert.equal(result.posts[0].body, body);
  } finally { globalThis.fetch = original; }
});

test('posted jobs stay an ordered public page with unfunded payment disclosure', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return response({ version: 'voidpay.posted-jobs.v1', data: {
      ...payment, items: [posted('a'.repeat(64)), posted('b'.repeat(64), 'assigned')],
      nextCursor: null, private_token: 'private-canary',
    } });
  };
  try {
    const result = await invoke('posted_jobs', { limit: 2, after: '0'.repeat(64) });
    assert.equal(calls[0][0], `https://api.voidly.ai/v1/marketplace/posted-jobs?limit=2&after=${'0'.repeat(64)}`);
    assert.equal(calls[0][1].method, 'GET');
    assert.equal(calls[0][1].credentials, 'omit');
    assert.equal(calls[0][1].redirect, 'manual');
    assert.deepEqual(result.paymentDisclosure, payment);
    assert.equal(result.paymentPerformed, false);
    assert.equal(result.searchScope, 'one-public-page');
    assert.deepEqual(result.items.map(item => [item.jobId, item.status, item.claimsAvailable]), [
      ['a'.repeat(64), 'published', true], ['b'.repeat(64), 'assigned', false],
    ]);
    assert.equal(JSON.stringify(result).includes('private-canary'), false);
    assert.equal(JSON.stringify(result).includes('paymentStatus'), false);
  } finally { globalThis.fetch = original; }
});

test('invalid board and job inputs cause no request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected'); };
  try {
    assert.deepEqual(await invoke('board_search', { board: 'owner', limit: 1 }), { error: { code: 'INVALID_INPUT' } });
    assert.deepEqual(await invoke('board_search', { q: 'x', limit: 1 }), { error: { code: 'INVALID_INPUT' } });
    assert.deepEqual(await invoke('board_search', { limit: 21 }), { error: { code: 'INVALID_INPUT' } });
    assert.deepEqual(await invoke('posted_jobs', { after: '../../owner' }), { error: { code: 'INVALID_INPUT' } });
    assert.deepEqual(await invoke('posted_jobs', { limit: 50 }), { error: { code: 'INVALID_INPUT' } });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('malformed public pages and changed payment terms fail closed', async () => {
  const original = globalThis.fetch;
  try {
    const badBoard = [
      { posts: [{ ...boardPost, author_affiliation: 'owner' }], next_cursor: null },
      { posts: [boardPost, boardPost], next_cursor: null },
      { posts: [], next_cursor: 'bad' },
    ];
    for (const value of badBoard) {
      globalThis.fetch = async () => response(value);
      assert.deepEqual(await invoke('board_search', { limit: 2 }), { error: { code: 'INVALID_RESPONSE' } });
    }
    const badJobs = [
      { ...payment, fundsReserved: true, items: [], nextCursor: null },
      { ...payment, items: [posted('a'.repeat(64), 'assigned')], nextCursor: null,
        // Public DTO says an assigned job is not claimable.
      },
      { ...payment, items: [posted('a'.repeat(64))], nextCursor: 'b'.repeat(64) },
    ];
    badJobs[1].items[0].claimsAvailable = true;
    for (const data of badJobs) {
      globalThis.fetch = async () => response({ version: 'voidpay.posted-jobs.v1', data });
      assert.deepEqual(await invoke('posted_jobs', { limit: 1 }), { error: { code: 'INVALID_RESPONSE' } });
    }
  } finally { globalThis.fetch = original; }
});

test('non-200, redirects, and oversized bodies never become empty inventory', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await invoke('board_search', {}), { error: { code: 'PUBLIC_READ_UNAVAILABLE' } });
    globalThis.fetch = async () => new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await invoke('board_search', {}), { error: { code: 'RATE_LIMITED' } });
    globalThis.fetch = async () => new Response('{}', { status: 302,
      headers: { Location: 'https://other.example/', 'Content-Type': 'application/json' } });
    assert.deepEqual(await invoke('posted_jobs', {}), { error: { code: 'PUBLIC_READ_UNAVAILABLE' } });
    globalThis.fetch = async () => new Response('x'.repeat(262_145),
      { headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(await invoke('posted_jobs', {}), { error: { code: 'INVALID_RESPONSE' } });
  } finally { globalThis.fetch = original; }
});
