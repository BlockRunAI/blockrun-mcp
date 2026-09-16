/**
 * The confirm gate for every script under scripts/ that moves real funds.
 *
 *   npx tsx scripts/polymarket-e2e-live.ts --confirm
 *   POLYMARKET_E2E_CONFIRM=1 npm run e2e:polymarket:withdraw
 *
 * Nothing in scripts/ may spend by being run. smoke-speech.ts got its gate
 * after a bare invocation charged for a sound effect it advertised as a
 * $0.001 speak; the three Polymarket scripts that submit a $2 withdrawal or
 * sign the unlimited approval batch were carved out of that rule because they
 * go through utils/ rather than a tool handler — a distinction that matters
 * to a test and not at all to the wallet. This repo has already lost $0.42 to
 * an agent that ran a paid path because it looked like a read.
 *
 * Its own switch, not smoke-speech's: BLOCKRUN_SMOKE_CONFIRM exported for a
 * $0.06 smoke run must not have pre-authorised a $2 bridge.
 *
 * Injectable argv/env/exit so test/e2e-confirm.test.ts can prove the refusal
 * without running a script.
 */
export const CONFIRM_FLAG = "--confirm";
export const CONFIRM_ENV = "POLYMARKET_E2E_CONFIRM";

type Io = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  exit?: (code: number) => never;
};

/**
 * Print what the script is about to do with real money and stop, unless the
 * caller said --confirm (or POLYMARKET_E2E_CONFIRM=1). Call it before the
 * first await: a gate that comes after the withdrawal is a receipt.
 */
export function requireLiveConfirm(wouldMove: string[], io: Io = {}): void {
  const argv = io.argv ?? process.argv.slice(2);
  const env = io.env ?? process.env;
  if (argv.includes(CONFIRM_FLAG) || env[CONFIRM_ENV] === "1") return;
  const stderr = io.stderr ?? ((line: string) => console.error(line));
  const exit = io.exit ?? ((code: number) => process.exit(code));
  stderr("This script moves REAL funds from the machine-global wallet. Without confirmation it would have:");
  for (const line of wouldMove) stderr(`  - ${line}`);
  stderr(`Nothing was submitted. Re-run with ${CONFIRM_FLAG}, or set ${CONFIRM_ENV}=1, to authorise it.`);
  exit(1);
}
