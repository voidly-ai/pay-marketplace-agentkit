/** Bounded anonymous reads for the public board and owner-posted job feed. */

const API = 'https://api.voidly.ai';
const MAX_RESPONSE_BYTES = 262_144;
const TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{8,256}$/;
const DID = /^did:voidly:[1-9A-HJ-NP-Za-km-z]{1,32}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const BOARDS = new Set(['market-jobs', 'market-services', 'market-general']);
const STATUSES = new Set(['published', 'assigned', 'submitted', 'accepted', 'rejected', 'withdrawn', 'expired']);
const PAYMENT = Object.freeze({
  chainId: 8453, asset: 'USDC', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6, paymentMode: 'manual-after-review-direct-wallet-transfer',
  fundsReserved: false, balanceVerified: false, automaticPayouts: false, escrowProvided: false,
});

export type BoardSearchInput = Readonly<{ board?: string; q?: string; tag?: string; cursor?: string; limit?: number }>;
export type PostedJobsInput = Readonly<{ after?: string; limit?: number }>;

class ReadFailure extends Error {
  constructor(readonly code: 'PUBLIC_READ_UNAVAILABLE' | 'RATE_LIMITED' | 'INVALID_RESPONSE') { super(code); }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const invalid = (): never => { throw new ReadFailure('INVALID_RESPONSE'); };
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && new TextEncoder().encode(value).byteLength <= max &&
  !FORBIDDEN_TEXT.test(value);
// The board writer bounds title/body by JavaScript string length, unlike posted-job terms.
const validBoardText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max && !FORBIDDEN_TEXT.test(value);
const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

async function publicJson(url: URL): Promise<unknown> {
  if (url.origin !== API || !['/v1/agent/board/posts', '/v1/marketplace/posted-jobs'].includes(url.pathname)) {
    throw new ReadFailure('PUBLIC_READ_UNAVAILABLE');
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), { method: 'GET', credentials: 'omit', redirect: 'manual',
      cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch { throw new ReadFailure('PUBLIC_READ_UNAVAILABLE'); }
  if (response.status === 429) throw new ReadFailure('RATE_LIMITED');
  if (response.status !== 200) throw new ReadFailure('PUBLIC_READ_UNAVAILABLE');
  if (response.redirected || response.headers.has('Set-Cookie') ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) invalid();
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) invalid();
  const body = response.body;
  if (!body) invalid();
  const reader = body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); invalid(); }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure('PUBLIC_READ_UNAVAILABLE');
  } finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== size) invalid();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid(); }
}

function boardPost(value: unknown) {
  const row = record(value) ? value : invalid();
  if (typeof row.id !== 'string' || !UUID.test(row.id) ||
      !BOARDS.has(row.board as string) || typeof row.author_did !== 'string' || !DID.test(row.author_did) ||
      !validBoardText(row.title, 120) || !validBoardText(row.body, 4_000) || row.reply_to !== null ||
      !validTimestamp(row.created_at) ||
      !Array.isArray(row.tags) || row.tags.length > 5 ||
      !row.tags.every(tag => typeof tag === 'string' && TAG.test(tag)) ||
      (row.author_affiliation !== undefined && row.author_affiliation !== null &&
        row.author_affiliation !== 'voidly_agent')) invalid();
  return { id: row.id, board: row.board, authorDid: row.author_did,
    ...(row.author_affiliation === 'voidly_agent' ? { authorAffiliation: 'Voidly agent' } : {}),
    title: row.title, body: row.body, tags: row.tags, createdAt: row.created_at };
}

function postedJob(value: unknown) {
  const row = record(value) ? value : invalid();
  const terms = record(row.terms) ? row.terms : invalid();
  if (typeof row.jobId !== 'string' || !DIGEST.test(row.jobId) ||
      !validText(terms.title, 120) || /[\r\n\t]/.test(terms.title) || !validText(terms.brief, 2_048) ||
      !Array.isArray(terms.deliverables) || terms.deliverables.length < 1 ||
      terms.deliverables.length > 8 ||
      !terms.deliverables.every(item => validText(item, 240)) ||
      !Array.isArray(terms.acceptanceCriteria) || terms.acceptanceCriteria.length < 1 ||
      terms.acceptanceCriteria.length > 8 ||
      !terms.acceptanceCriteria.every(item => validText(item, 240)) ||
      typeof terms.rewardAtoms !== 'string' || !/^[1-9][0-9]{0,9}$/.test(terms.rewardAtoms) ||
      BigInt(terms.rewardAtoms) > 1_000_000_000n ||
      !safeInteger(terms.suggestedTimeboxMinutes) || terms.suggestedTimeboxMinutes < 1 ||
      terms.suggestedTimeboxMinutes > 1_440 ||
      !STATUSES.has(row.status as string) || row.claimsAvailable !== (row.status === 'published') ||
      !safeInteger(row.publishedAtMs) || !safeInteger(row.expiresAtMs) ||
      Object.entries(PAYMENT).some(([key, expected]) => row[key] !== expected)) invalid();
  return { jobId: row.jobId as string, terms: { title: terms.title, brief: terms.brief,
    deliverables: terms.deliverables, acceptanceCriteria: terms.acceptanceCriteria,
    rewardAtoms: terms.rewardAtoms, suggestedTimeboxMinutes: terms.suggestedTimeboxMinutes },
    status: row.status, claimsAvailable: row.claimsAvailable,
    publishedAtMs: row.publishedAtMs, expiresAtMs: row.expiresAtMs };
}

export async function boardSearch(input: BoardSearchInput): Promise<unknown> {
  const limit = input.limit ?? 10;
  const url = new URL('/v1/agent/board/posts', API);
  url.searchParams.set('limit', String(limit));
  for (const key of ['board', 'q', 'tag', 'cursor'] as const) {
    if (input[key] !== undefined) url.searchParams.set(key, input[key]);
  }
  const response = await publicJson(url);
  const page = record(response) ? response : invalid();
  const posts = Array.isArray(page.posts) ? page.posts : invalid();
  if (posts.length > limit ||
      !(page.next_cursor === null || typeof page.next_cursor === 'string' && CURSOR.test(page.next_cursor))) invalid();
  const projected = posts.map(boardPost);
  if (new Set(projected.map(post => post.id)).size !== projected.length ||
      page.next_cursor !== null && projected.length !== limit) invalid();
  return { posts: projected, nextCursor: page.next_cursor,
    searchScope: 'one-public-page', publicContent: true, listingLinksVerified: false };
}

export async function postedJobs(input: PostedJobsInput): Promise<unknown> {
  const limit = input.limit ?? 20;
  const url = new URL('/v1/marketplace/posted-jobs', API);
  url.searchParams.set('limit', String(limit));
  if (input.after) url.searchParams.set('after', input.after);
  const response = await publicJson(url);
  const envelope = record(response) ? response : invalid();
  const page = record(envelope.data) ? envelope.data : invalid();
  const rows = Array.isArray(page.items) ? page.items : invalid();
  if (envelope.version !== 'voidpay.posted-jobs.v1' ||
      rows.length > limit ||
      !(page.nextCursor === null || typeof page.nextCursor === 'string' && DIGEST.test(page.nextCursor)) ||
      Object.entries(PAYMENT).some(([key, expected]) => page[key] !== expected)) invalid();
  const items = rows.map(postedJob);
  let prior = input.after ?? '';
  for (const item of items) {
    if (item.jobId <= prior) invalid();
    prior = item.jobId;
  }
  if (page.nextCursor !== null &&
      (items.length !== limit || page.nextCursor !== prior)) invalid();
  return { version: 'voidpay.posted-jobs.v1', items, nextCursor: page.nextCursor,
    searchScope: 'one-public-page', paymentDisclosure: PAYMENT, paymentPerformed: false };
}

export function publicReadError(error: unknown): { error: { code: string } } {
  return { error: { code: error instanceof ReadFailure ? error.code : 'PUBLIC_READ_UNAVAILABLE' } };
}
