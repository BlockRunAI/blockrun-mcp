// Run with: npm test  (tsx --experimental-test-module-mocks --test)
//
// The account-vs-wallet decision, pinned against a real temp HOME.
//
// Two of these are money bugs rather than behaviour preferences:
//
//   - "API-key mode never provisions a wallet". Every client factory used to
//     call getOrCreateWalletKey() eagerly, and that call MINTS: it writes
//     ~/.blockrun/.session, mirrors the key into the OS keychain, and announces
//     a new wallet on stderr. A user who pays by invoice would have had a
//     keypair created and stored for them on their first paid call.
//
//   - "a poll URL resolves on the rail that took the payment". Async jobs are
//     billed at submit; a poll sent to the wrong host can never collect the
//     result, so the charge is simply lost. The old
//     `BLOCKRUN_API.replace(/\/api$/, "") + poll_url` reconstruction sent every
//     account-mode poll to the wallet gateway, unauthenticated.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Same discipline as chain-precedence.test.ts: HOME is fixed before the dynamic
// import, because wallet.ts captures its paths at import time. The keychain is
// switched off so these assertions read files, not a developer's real keychain.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-auth-"));
const blockrunDir = path.join(home, ".blockrun");
fs.mkdirSync(blockrunDir, { recursive: true });
const realHome = process.env.HOME;
const savedKeychain = process.env.BLOCKRUN_KEYCHAIN;
const savedApiKey = process.env.BLOCKRUN_API_KEY;
const savedApiBase = process.env.BLOCKRUN_API_BASE_URL;
const savedWalletKey = process.env.BLOCKRUN_WALLET_KEY;
const savedSolanaKey = process.env.SOLANA_WALLET_KEY;
process.env.HOME = home;
process.env.BLOCKRUN_KEYCHAIN = "off";
delete process.env.BLOCKRUN_API_KEY;
delete process.env.BLOCKRUN_WALLET_KEY;
delete process.env.SOLANA_WALLET_KEY;

const auth = await import("../src/utils/auth.js");
const wallet = await import("../src/utils/wallet.js");

const VALID_KEY = "brk_live_H4OzmQQDX09FElTg06Gv3Wh7i6C5jIozzVH0QBW5";

beforeEach(() => {
  for (const f of [".chain", ".chain-auto", ".solana-session", ".session", ".api-key"]) {
    fs.rmSync(path.join(blockrunDir, f), { force: true });
  }
  delete process.env.BLOCKRUN_API_KEY;
  delete process.env.BLOCKRUN_API_BASE_URL;
  delete process.env.BLOCKRUN_WALLET_KEY;
  delete process.env.SOLANA_WALLET_KEY;
  auth.resetAuthCache();
  wallet.resetEvmWalletCache();
  wallet.resetSolanaKeyCache();
  wallet.resetKeychainProbeCache();
});

afterEach(() => {
  auth.resetAuthCache();
});

process.on("exit", () => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("BLOCKRUN_KEYCHAIN", savedKeychain);
  restore("BLOCKRUN_API_KEY", savedApiKey);
  restore("BLOCKRUN_API_BASE_URL", savedApiBase);
  restore("BLOCKRUN_WALLET_KEY", savedWalletKey);
  restore("SOLANA_WALLET_KEY", savedSolanaKey);
  restore("HOME", realHome);
  fs.rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// Key resolution
// --------------------------------------------------------------------------

test("no BLOCKRUN_API_KEY means wallet mode", () => {
  assert.equal(auth.getApiKey(), undefined);
  assert.equal(auth.getAuthMode(), "wallet");
  assert.equal(auth.isApiKeyMode(), false);
});

test("a valid key selects API-key mode", () => {
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.equal(auth.getApiKey(), VALID_KEY);
  assert.equal(auth.getAuthMode(), "api-key");
});

test("surrounding whitespace is trimmed, not rejected", () => {
  process.env.BLOCKRUN_API_KEY = `  ${VALID_KEY}\n`;
  auth.resetAuthCache();
  assert.equal(auth.getApiKey(), VALID_KEY);
});

// A malformed key must NOT degrade to the wallet. Someone who believes they are
// spending prepaid credit would otherwise start spending USDC, with a typo as
// the only cause and nothing on screen to connect the two.
test("a malformed key throws instead of silently falling back to the wallet", () => {
  for (const bad of ["sk-not-a-blockrun-key", "brk", "brk_live_has spaces", "hello"]) {
    process.env.BLOCKRUN_API_KEY = bad;
    auth.resetAuthCache();
    assert.throws(() => auth.getApiKey(), /does not contain a valid BlockRun API key/, `should reject ${bad}`);
    assert.throws(() => auth.getApiKey(), /BLOCKRUN_API_KEY/, "the message names where the bad key came from");
  }
});

// Carried over from PR #136. A stdio MCP server is launched by its client, and
// several clients make setting an environment variable awkward — the wallet has
// always had ~/.blockrun/.session for exactly that reason, and the key needs the
// same escape hatch.
test("a key in ~/.blockrun/.api-key is used when the env var is unset", () => {
  fs.writeFileSync(path.join(blockrunDir, ".api-key"), `${VALID_KEY}\n`);
  auth.resetAuthCache();
  assert.equal(auth.getApiKey(), VALID_KEY);
  assert.equal(auth.getAuthMode(), "api-key");
  fs.rmSync(path.join(blockrunDir, ".api-key"), { force: true });
});

// Mirrors the wallet precedence (BLOCKRUN_WALLET_KEY outranks .session): an
// explicitly exported key is a deliberate override and must not be shadowed by
// whatever happens to be on disk from an earlier account.
test("the env var outranks the file", () => {
  const other = "brk_live_ffffffffffffffffffffffffffffffff";
  fs.writeFileSync(path.join(blockrunDir, ".api-key"), other);
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.equal(auth.getApiKey(), VALID_KEY, "the exported key wins");
  fs.rmSync(path.join(blockrunDir, ".api-key"), { force: true });
});

test("a malformed key IN THE FILE throws, naming the file rather than the env var", () => {
  fs.writeFileSync(path.join(blockrunDir, ".api-key"), "sk-wrong-vendor");
  auth.resetAuthCache();
  assert.throws(() => auth.getApiKey(), /\.api-key/, "the message must name where the bad key came from");
  fs.rmSync(path.join(blockrunDir, ".api-key"), { force: true });
});

test("an empty .api-key file is treated as unset, not as malformed", () => {
  fs.writeFileSync(path.join(blockrunDir, ".api-key"), "  \n");
  auth.resetAuthCache();
  assert.equal(auth.getApiKey(), undefined);
  assert.equal(auth.getAuthMode(), "wallet");
  fs.rmSync(path.join(blockrunDir, ".api-key"), { force: true });
});

test("an empty key is treated as unset, not as malformed", () => {
  process.env.BLOCKRUN_API_KEY = "   ";
  auth.resetAuthCache();
  assert.equal(auth.getApiKey(), undefined);
  assert.equal(auth.getAuthMode(), "wallet");
});

// --------------------------------------------------------------------------
// Base URL
// --------------------------------------------------------------------------

test("the account base accepts both the root and the OpenAI-style /v1 form", () => {
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.equal(auth.getApiKeyBase(), "https://api.blockrun.ai");

  for (const configured of [
    "https://staging.example.com",
    "https://staging.example.com/",
    "https://staging.example.com/v1",
    "https://staging.example.com/v1/",
  ]) {
    process.env.BLOCKRUN_API_BASE_URL = configured;
    assert.equal(auth.getApiKeyBase(), "https://staging.example.com", configured);
  }
});

test("getApiBase follows the active rail", () => {
  // Wallet + Base.
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "base");
  assert.equal(wallet.getApiBase(), "https://blockrun.ai/api");

  // Wallet + Solana.
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "solana");
  assert.equal(wallet.getApiBase(), "https://sol.blockrun.ai/api");

  // Account. Outranks the chain preference entirely — there is no chain.
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.equal(wallet.getApiBase(), "https://api.blockrun.ai");
});

// --------------------------------------------------------------------------
// Poll URLs — the lost-payment hazard
// --------------------------------------------------------------------------

test("a relative poll URL resolves onto the rail that took the payment", () => {
  const pollPath = "/api/v1/videos/generations/job_123";

  fs.writeFileSync(path.join(blockrunDir, ".chain"), "base");
  assert.equal(
    wallet.resolveGatewayUrl(pollPath),
    "https://blockrun.ai/api/v1/videos/generations/job_123",
  );

  fs.writeFileSync(path.join(blockrunDir, ".chain"), "solana");
  assert.equal(
    wallet.resolveGatewayUrl(pollPath),
    "https://sol.blockrun.ai/api/v1/videos/generations/job_123",
  );

  // The account API serves /v1 at its root, so the gateway's /api prefix is
  // dropped exactly once. Concatenation would have produced
  // https://api.blockrun.ai/api/v1/... — a 404 for a job already billed.
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.equal(
    wallet.resolveGatewayUrl(pollPath),
    "https://api.blockrun.ai/v1/videos/generations/job_123",
  );
});

test("a poll URL that already lacks the /api prefix is not double-stripped", () => {
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "base");
  assert.equal(
    wallet.resolveGatewayUrl("/v1/audio/generations/job_9"),
    "https://blockrun.ai/api/v1/audio/generations/job_9",
  );
});

test("an absolute poll URL on the paying origin is accepted as-is", () => {
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "base");
  assert.equal(
    wallet.resolveGatewayUrl("https://blockrun.ai/api/v1/videos/generations/j"),
    "https://blockrun.ai/api/v1/videos/generations/j",
  );
});

// Following it would send a payment header (or a Bearer key) to a host that did
// not take the payment — credential leak on one rail, lost job on the other.
test("an absolute poll URL on a DIFFERENT origin is refused", () => {
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "base");
  assert.throws(
    () => wallet.resolveGatewayUrl("https://evil.example.com/api/v1/videos/generations/j"),
    /different origin/,
  );

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.throws(
    () => wallet.resolveGatewayUrl("https://blockrun.ai/api/v1/videos/generations/j"),
    /different origin/,
    "the wallet gateway is a different origin from the account API",
  );
});

// --------------------------------------------------------------------------
// No wallet is ever minted on the account rail
// --------------------------------------------------------------------------

const walletFiles = () =>
  fs.existsSync(blockrunDir) ? fs.readdirSync(blockrunDir).sort() : [];

test("API-key mode never provisions a wallet", async () => {
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  const before = walletFiles();

  // Every client factory, plus the status path behind blockrun://wallet.
  wallet.getClient();
  wallet.buildClient();
  wallet.buildClientWithTimeout(1_000);
  wallet.getImageClient();
  wallet.getPriceClient();
  wallet.getAnthropicClient();
  const info = await wallet.getWalletInfo();

  assert.deepEqual(walletFiles(), before, "no key file may appear under ~/.blockrun");
  assert.equal(fs.existsSync(path.join(blockrunDir, ".session")), false);
  assert.equal(fs.existsSync(path.join(blockrunDir, ".solana-session")), false);

  assert.equal(info.address, null, "an account has no address");
  assert.equal(info.network, "BlockRun account");
  assert.match(info.fundingUrl, /user\.blockrun\.ai/);
});

// --------------------------------------------------------------------------
// Degradation
// --------------------------------------------------------------------------

test("requireWalletMode is silent in wallet mode and actionable in account mode", () => {
  assert.equal(auth.requireWalletMode("Polymarket trading"), null);

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  const msg = auth.requireWalletMode("Polymarket trading");
  assert.ok(msg, "account mode must refuse");
  assert.match(msg, /Polymarket trading/, "names the capability");
  assert.match(msg, /BLOCKRUN_API_KEY/, "names the switch back to wallet mode");
  assert.match(msg, /user\.blockrun\.ai/, "points at the portal");
});

// The chain guards are a statement about the SOLANA GATEWAY. On the account
// rail there is no chain, and api.blockrun.ai serves every family — so a guard
// that still fired there would refuse calls that work.
test("baseOnlyMessage is inert on the account rail", () => {
  fs.writeFileSync(path.join(blockrunDir, ".chain"), "solana");
  assert.ok(wallet.baseOnlyMessage("blockrun_defi"), "wallet+Solana still refuses");

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.equal(wallet.baseOnlyMessage("blockrun_defi"), null);
});

test("apiAuthHeaders is empty in wallet mode and a Bearer token in account mode", () => {
  assert.deepEqual(auth.apiAuthHeaders(), {});

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetAuthCache();
  assert.deepEqual(auth.apiAuthHeaders(), { Authorization: `Bearer ${VALID_KEY}` });
});
