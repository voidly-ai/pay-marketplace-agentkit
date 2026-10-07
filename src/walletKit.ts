/** Opt-in wallet-kit 0.2.0 commerce boundary. The host retains custody and policy. */
import type { BaseNetwork, VoidlySellerListingInput } from '@voidly/agent-wallet';

const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const QUOTE_ID = /^0x[0-9a-f]{64}$/;
const USD = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/;
const MAX_INPUT_BYTES = 65_536;
const MAX_LISTING_BYTES = 12_000;

export type BuyIntent = Readonly<{
  kind: 'buy'; network: BaseNetwork; listingId: string; version: number;
  input: Readonly<Record<string, unknown>>;
  perCallUsd: string; dailyUsd: string; maxUsd: string;
}>;
export type SellIntent = Readonly<{
  kind: 'sell'; network: BaseNetwork; listing: Readonly<VoidlySellerListingInput>;
}>;
export type WalletKitV02Intent = BuyIntent | SellIntent;

/**
 * Host executes wallet-kit 0.2.0's public CLI or an equivalent implementation.
 * Its approval must bind the exact intent to a one-use policy decision. The host
 * owns encrypted wallet state, durable spend/attempt stores, and private files.
 */
export interface WalletKitV02Host {
  readonly walletKitVersion: '0.2.0';
  readonly network: BaseNetwork;
  readonly perCallUsd: string;
  readonly dailyUsd: string;
  readonly maxUsd: string;
  /** Return a fresh, opaque one-use permit or null. Never return wallet material. */
  authorize(intent: WalletKitV02Intent): Promise<object | null>;
  executeBuy(intent: BuyIntent, permit: object): Promise<unknown>;
  executeSell(intent: SellIntent, permit: object): Promise<unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Copy only own JSON values. Avoid getters, toJSON hooks, prototypes and cycles. */
function checkedJsonObject(value: unknown, maxBytes: number): Record<string, unknown> | null {
  let nodes = 0;
  const ancestors = new Set<object>();
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 2_048 || depth > 16) throw new Error('invalid JSON');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string' && item.length <= 16_384 &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) return item;
    if (typeof item === 'number' && Number.isFinite(item) &&
        (!Number.isInteger(item) || Number.isSafeInteger(item))) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('invalid JSON');
    if (Array.isArray(item)) {
      if (item.length > 2_048) throw new Error('invalid JSON');
      ancestors.add(item);
      const result: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid JSON');
        result.push(copy(descriptor.value, depth + 1));
      }
      ancestors.delete(item);
      return result;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid JSON');
    ancestors.add(item);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(item)) {
      if (key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('invalid JSON');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid JSON');
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  }
  try {
    if (!record(value)) return null;
    const result = copy(value, 0) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) return null;
    return result;
  } catch { return null; }
}

function network(value: unknown): value is BaseNetwork {
  return value === 'base' || value === 'base-sepolia';
}

function freezeIntent<T extends WalletKitV02Intent>(intent: T): T {
  function freeze(value: unknown): void {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(intent);
  return intent;
}

export async function buyIntent(raw: unknown, host: WalletKitV02Host): Promise<BuyIntent | null> {
  const value = checkedJsonObject(raw, MAX_INPUT_BYTES);
  if (!value || Object.keys(value).sort().join(',') !==
      'input,listingId,version' ||
      !network(host.network) || host.walletKitVersion !== '0.2.0' ||
      typeof value.listingId !== 'string' || !LISTING_ID.test(value.listingId) ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
      typeof host.perCallUsd !== 'string' || !USD.test(host.perCallUsd) ||
      typeof host.dailyUsd !== 'string' || !USD.test(host.dailyUsd) ||
      typeof host.maxUsd !== 'string' || !USD.test(host.maxUsd) ||
      !checkedJsonObject(value.input, MAX_INPUT_BYTES)) return null;
  try {
    const { validateSpendLimits, usdToAtomic } = await import('@voidly/agent-wallet');
    const caps = validateSpendLimits({ perCallUsd: host.perCallUsd, dailyUsd: host.dailyUsd });
    const max = usdToAtomic(host.maxUsd);
    if (max <= 0n || max > caps.perCall) return null;
  } catch { return null; }
  return freezeIntent({ kind: 'buy', network: host.network, listingId: value.listingId,
    version: value.version as number, input: value.input as Record<string, unknown>,
    perCallUsd: host.perCallUsd, dailyUsd: host.dailyUsd, maxUsd: host.maxUsd });
}

export async function sellIntent(raw: unknown, host: WalletKitV02Host): Promise<SellIntent | null> {
  const value = checkedJsonObject(raw, MAX_LISTING_BYTES);
  if (!value || Object.keys(value).sort().join(',') !== 'listing' ||
      !network(host.network) || host.walletKitVersion !== '0.2.0' ||
      !checkedJsonObject(value.listing, MAX_LISTING_BYTES)) return null;
  try {
    const { validateVoidlySellerListingInput } = await import('@voidly/agent-wallet');
    const listing = validateVoidlySellerListingInput(value.listing);
    if (listing.method !== 'POST') return null;
    return freezeIntent({ kind: 'sell', network: host.network, listing });
  } catch { return null; }
}

function uncertain(error: unknown): Record<string, unknown> | null {
  if (!record(error) || error.paymentMayHaveSettled !== true) return null;
  const quoteId = typeof error.quoteId === 'string' && QUOTE_ID.test(error.quoteId) ? error.quoteId : null;
  return { status: 'payment_uncertain', paymentMayHaveSettled: true, doNotRepay: true,
    quoteId, recoverWith: quoteId ? 'wallet_recover_marketplace' : 'wallet_marketplace_attempts' };
}

export function buyResult(result: unknown, intent: BuyIntent): Record<string, unknown> {
  const pending = uncertain(result);
  if (pending) return pending;
  if (!record(result) || result.command !== 'buy' || result.network !== intent.network ||
      result.listingId !== intent.listingId || result.version !== intent.version ||
      result.receiptVerified !== true || result.doNotRepay !== true ||
      (result.verifiedStatus !== 'delivered' && result.verifiedStatus !== 'refund_owed') ||
      typeof result.bodyComplete !== 'boolean') return { error: { code: 'INVALID_WALLET_RESULT' } };
  const quoteId = typeof result.quoteId === 'string' && QUOTE_ID.test(result.quoteId) ? result.quoteId : null;
  const status = result.verifiedStatus === 'delivered' && result.bodyComplete === false
    ? 'delivery_incomplete' : result.verifiedStatus;
  return { status, receiptVerified: true,
    refundOwed: result.verifiedStatus === 'refund_owed', doNotRepay: true,
    bodyComplete: result.bodyComplete, quoteId,
    recoverWith: quoteId ? 'wallet_recover_marketplace' : 'wallet_marketplace_attempts' };
}

export function sellResult(result: unknown, intent: SellIntent): Record<string, unknown> {
  if (!record(result) || result.command !== 'sell' || result.network !== intent.network ||
      result.status !== 'pending_activation' ||
      typeof result.listingId !== 'string' || !LISTING_ID.test(result.listingId) ||
      !Number.isSafeInteger(result.version) || (result.version as number) < 1) {
    return { error: { code: 'INVALID_WALLET_RESULT' } };
  }
  return { status: 'pending_activation', network: intent.network, listingId: result.listingId,
    version: result.version, activationRequired: true };
}

export function walletError(caught: unknown, kind: 'buy' | 'sell'): Record<string, unknown> {
  if (kind === 'buy') return uncertain(caught) ?? { error: { code: 'WALLET_ACTION_UNAVAILABLE' } };
  if (record(caught) && (caught.code === 'seller_creation_uncertain' ||
      caught.code === 'seller_secret_persistence_failed')) {
    return { status: 'seller_creation_uncertain', doNotRetry: true,
      reconciliationRequired: true };
  }
  return { error: { code: 'WALLET_ACTION_UNAVAILABLE' } };
}
