// Preloaded into EVERY test process by the `test` script in package.json:
//
//   tsx --experimental-test-module-mocks --import ./test/_setup.ts --test test/*.test.ts
//
// node's test runner hands its own execArgv to each child it spawns, so this
// runs once per test file, before that file's first import. It is not a test
// (the glob is *.test.ts) and it registers nothing; it pins the environment.
//
// WHY: the wallet, the chain preference and the account API key all live under
// ~/.blockrun on the developer's machine, and utils/auth.ts, utils/wallet.ts
// and utils/constants.ts capture os.homedir() at import time. A suite that
// mocks fetch and the SDK clients but not auth.js still asks isApiKeyMode()
// first — and on a machine with ~/.blockrun/.api-key the answer switched ten
// mocked-handler suites onto the account rail, where the Base-rail assertions
// they exist for were never exercised. Only image-cost.test.ts had pinned
// itself. Pinning here means the verdict is the same on every machine and no
// suite has to remember to do it; a suite that WANTS the account rail mocks
// auth.js or sets BLOCKRUN_API_KEY itself, and restores it.
//
// The home is a fresh empty directory, not a nonexistent path: code under test
// is allowed to mkdir ~/.blockrun and write a session into it, and a real
// directory is what it would find on a first run. test/harness-pin.test.ts is
// the assertion that this actually took effect.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "blockrun-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// Every variable that selects a rail, a chain, a key, a gateway or a price.
// Wildcarded by prefix so a new BLOCKRUN_* knob cannot leak in unpinned.
for (const key of Object.keys(process.env)) {
  if (/^(BLOCKRUN_|SOLANA_|POLYMARKET_)/.test(key) || key === "BASE_CHAIN_WALLET_KEY" || key === "TRANSACTION_FEE_USD") {
    delete process.env[key];
  }
}

process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});
