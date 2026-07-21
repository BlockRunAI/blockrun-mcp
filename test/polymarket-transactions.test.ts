import test from "node:test";
import assert from "node:assert/strict";
import { assertTransactionSucceeded } from "../src/utils/polymarket/transactions.js";

test("a reverted receipt is never treated as a confirmed state change", () => {
  assert.doesNotThrow(() => assertTransactionSucceeded({ status: "success" }, "test"));
  assert.throws(() => assertTransactionSucceeded({ status: "reverted" }, "USDC.e wrap"), /reverted/);
  assert.throws(() => assertTransactionSucceeded({}, "withdrawal"), /reverted/);
});
