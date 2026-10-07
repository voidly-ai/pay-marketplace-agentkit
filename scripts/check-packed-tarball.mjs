#!/usr/bin/env node

// Audit the exact offline npm archive without running lifecycle scripts.
// The bounded archive and consumer probe stay in a fresh temp directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, statfsSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const expectedName = '@voidly/pay-marketplace-agentkit';
const expectedFiles = [
  'package.json', 'README.md', 'LICENSE',
  'dist/index.js', 'dist/index.d.ts',
  'dist/publicReads.js', 'dist/publicReads.d.ts',
  'dist/walletKit.js', 'dist/walletKit.d.ts',
];
const expectedPaths = new Set(expectedFiles.map((path) => 'package/' + path));
const allowedDirectories = new Set(['package/', 'package/dist/']);
const maxArchiveBytes = 2 * 1024 * 1024;
const maxExpandedBytes = 4 * 1024 * 1024;
// Hosted GitHub runners have less than 50 GiB; this audit writes <4 MiB.
const isGithubHosted = process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const minFreeBytes = (isGithubHosted ? 1n : 50n) * 1024n ** 3n;

function fail(message) {
  throw new Error('packed-tarball audit: ' + message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, ...options,
  });
  if (result.error || result.status !== 0) {
    fail(command + ' failed (' + (result.error?.code ?? 'exit ' + result.status) +
      '); inspect the retained audit directory');
  }
  return result.stdout;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function tarOctal(bytes) {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(value)) fail('invalid tar number');
  return Number.parseInt(value, 8);
}

function tarEntries(archive) {
  const expanded = gunzipSync(archive, { maxOutputLength: maxExpandedBytes });
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!expanded.subarray(offset).every((byte) => byte === 0)) fail('nonzero tar trailer');
      return entries;
    }
    const recordedChecksum = tarOctal(header.subarray(148, 156));
    let actualChecksum = 0;
    for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
    if (actualChecksum !== recordedChecksum) fail('tar header checksum mismatch');

    const prefix = tarString(header.subarray(345, 500));
    const name = tarString(header.subarray(0, 100));
    const path = prefix ? prefix + '/' + name : name;
    const type = header[156];
    const size = tarOctal(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size > maxExpandedBytes ||
        !Number.isSafeInteger(offset + 512 + size) ||
        offset + 512 + size > expanded.length) fail('invalid tar entry size');
    if (entries.has(path)) fail('duplicate tar path: ' + path);
    if (path.includes('\\') || path.includes('\0') || path.startsWith('/') ||
        path.split('/').some((part) => part === '.' || part === '..')) {
      fail('unsafe tar path: ' + path);
    }
    if (type === 53 && allowedDirectories.has(path)) {
      if (size !== 0) fail('directory has data: ' + path);
      entries.set(path, null);
    } else if ((type === 0 || type === 48) && expectedPaths.has(path)) {
      // Reject links, PAX records, source, tests, dotfiles, and other paths.
      entries.set(path, Buffer.from(expanded.subarray(offset + 512, offset + 512 + size)));
    } else {
      fail('unexpected tar entry: ' + path + ' (type ' + type + ')');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fail('missing tar trailer');
}

function auditManifest(source, packed) {
  assert.equal(source.name, expectedName, 'source package name');
  assert.equal(packed.name, expectedName, 'packed package name');
  assert.match(source.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/, 'source version');
  assert.equal(packed.version, source.version, 'packed version must match source');
  assert.equal(source.type, 'module', 'source must be ESM');
  assert.equal(packed.type, 'module', 'packed package must be ESM');
  assert.notEqual(source.private, true, 'package must be publishable only after owner GO');
  const exportsShape = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  assert.deepEqual(source.exports, exportsShape, 'source export map');
  assert.deepEqual(packed.exports, exportsShape, 'packed export map');
  if (source.types !== undefined) assert.equal(source.types, './dist/index.d.ts');
  if (packed.types !== undefined) assert.equal(packed.types, './dist/index.d.ts');
  assert.deepEqual(packed.scripts, source.scripts, 'packed scripts must match source');
  assert.deepEqual(packed.files, source.files, 'packed file list must match source');
  assert.deepEqual(packed.dependencies, source.dependencies, 'packed dependencies must match source');
  assert.deepEqual(packed.peerDependencies, source.peerDependencies, 'packed peers must match source');
  assert.deepEqual(source.publishConfig, { access: 'public' }, 'source publication access');
  assert.deepEqual(packed.publishConfig, source.publishConfig, 'packed publication access');
  for (const name of ['prepublish', 'prepublishOnly', 'publish', 'postpublish']) {
    if (Object.hasOwn(packed.scripts ?? {}, name)) fail('publication lifecycle script: ' + name);
  }
}

function auditSecrets(entries) {
  const patterns = [
    ['private key PEM', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['OpenAI-style token', /\bsk-[A-Za-z0-9_-]{32,}\b/],
    ['npm auth token', /(?:^|\n)\s*(?:\/\/[^\n]+\/:)?_authToken\s*=\s*\S+/i],
    ['credential assignment', /\b(?:api[_-]?key|access[_-]?token|private[_-]?key|signing[_-]?seed|client[_-]?secret)\b\s*[:=]\s*["'](?!example|your|placeholder|REPLACE)[A-Za-z0-9_\-/+=]{24,}["']/i],
  ];
  for (const path of expectedPaths) {
    const content = entries.get(path).toString('utf8');
    for (const [label, pattern] of patterns) {
      if (pattern.test(content)) fail(label + ' appears in ' + path);
    }
  }
}

function extractChecked(entries, destination) {
  for (const path of expectedPaths) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, entries.get(path), { flag: 'wx', mode: 0o600 });
  }
  return join(destination, 'package');
}

function auditConsumer(packageRoot) {
  const nodeModules = join(root, 'node_modules');
  if (!statSync(nodeModules).isDirectory()) fail('installed dependencies are missing');
  symlinkSync(nodeModules, join(packageRoot, 'node_modules'), 'dir');
  const consumer = join(packageRoot, '.audit-consumer.mjs');
  writeFileSync(consumer, [
    "import assert from 'node:assert/strict';",
    "globalThis.fetch = async () => { throw new Error('network use forbidden during package audit'); };",
    "const imported = await import('@voidly/pay-marketplace-agentkit');",
    "assert.equal(typeof imported.createVoidpayMarketplaceActionProvider, 'function');",
    "assert.equal(typeof imported.createVoidpayMarketplaceWalletKitActionProvider, 'function');",
    "const run = async () => { throw new Error('tool use forbidden during package audit'); };",
    "const publicActions = imported.createVoidpayMarketplaceActionProvider(run).getActions({});",
    "assert.deepEqual(publicActions.map((action) => action.name), [",
    "  'VoidpayMarketplaceActionProvider_voidpay_services',",
    "  'VoidpayMarketplaceActionProvider_voidpay_storefront',",
    "  'VoidpayMarketplaceActionProvider_voidpay_checkout_link',",
    "  'VoidpayMarketplaceActionProvider_board_search',",
    "  'VoidpayMarketplaceActionProvider_posted_jobs',",
    "]);",
    "const host = { walletKitVersion: '0.2.0', network: 'base-sepolia',",
    "  perCallUsd: '1', dailyUsd: '1', maxUsd: '1',",
    "  authorize: async () => null, executeBuy: async () => null, executeSell: async () => null };",
    "const walletActions = imported.createVoidpayMarketplaceWalletKitActionProvider(host, run).getActions({});",
    "assert.deepEqual(walletActions.slice(0, 5).map((action) => action.name), publicActions.map((action) => action.name));",
    "assert.deepEqual(walletActions.slice(5).map((action) => action.name), [",
    "  'VoidpayMarketplaceActionProvider_wallet_buy',",
    "  'VoidpayMarketplaceActionProvider_wallet_sell',",
    "]);",
    "for (const action of walletActions) {",
    "  assert.equal(typeof action.invoke, 'function');",
    "  assert.ok(action.schema);",
    "}",
    "const denied = JSON.parse(await walletActions[5].invoke({",
    "  listingId: 'listing_000', version: 1, input: {},",
    "}));",
    "assert.deepEqual(denied, { error: { code: 'OWNER_APPROVAL_REQUIRED' } });",
    "",
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  run(process.execPath, [consumer], {
    cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000,
  });
}

function main() {
  for (const path of [root, tmpdir()]) {
    const space = statfsSync(path, { bigint: true });
    if (space.bavail * space.bsize < minFreeBytes) {
      fail('less than ' + (isGithubHosted ? 1 : 50) + ' GiB free; no pack attempted');
    }
  }
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const temp = mkdtempSync(join(tmpdir(), 'voidly-agentkit-pack-'));
  console.log('Packed tarball audit directory (retained): ' + temp);
  const output = run('npm', [
    'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temp,
  ], {
    cwd: root,
    env: {
      ...process.env,
      npm_config_ignore_scripts: 'true', npm_config_offline: 'true',
      npm_config_cache: join(temp, 'npm-cache'), npm_config_audit: 'false',
      npm_config_fund: 'false', npm_config_update_notifier: 'false',
    },
  });
  const packs = JSON.parse(output);
  if (!Array.isArray(packs) || packs.length !== 1) fail('npm pack returned unexpected metadata');
  const pack = packs[0];
  if (pack.name !== expectedName || pack.version !== source.version ||
      pack.filename !== 'voidly-pay-marketplace-agentkit-' + source.version + '.tgz') {
    fail('npm pack name, version, or filename mismatch');
  }
  assert.deepEqual(pack.files?.map((file) => file.path).sort(), [...expectedFiles].sort(), 'npm pack file list');
  const archivePath = join(temp, pack.filename);
  const stat = lstatSync(archivePath);
  if (!stat.isFile() || stat.size > maxArchiveBytes) fail('archive is missing or too large');
  const archive = readFileSync(archivePath);
  const entries = tarEntries(archive);
  assert.deepEqual(
    [...entries].filter(([, bytes]) => bytes !== null).map(([path]) => path).sort(),
    [...expectedPaths].sort(), 'actual tar entries',
  );
  const packed = JSON.parse(entries.get('package/package.json').toString('utf8'));
  auditManifest(source, packed);
  auditSecrets(entries);
  auditConsumer(extractChecked(entries, join(temp, 'extracted')));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  console.log('Packed tarball PASS: ' + pack.filename + ' sha256=' + sha256 +
    ' (' + expectedFiles.length + ' files; ESM consumer OK; retained at ' + temp + ')');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
