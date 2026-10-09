// Non-vacuity control for `exec-sync-stderr.test.ts`. NOT production code:
// a plain inline `execFileSync` call WITHOUT an `stdio` option, run through
// the exact same fake-`ps`-on-PATH subprocess harness as the production
// worker. It exists to prove the harness can actually SEE a child's stderr
// forwarded into this worker's own stderr - so the production worker's
// negative assertions (marker absent) are evidence of the `stdio` fix,
// never of a harness that is blind to forwarding in the first place.
import { execFileSync } from "node:child_process";

function run(): string | null {
  try {
    return execFileSync("ps", ["-p", String(process.pid), "-o", "etime="], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

const result = run();
console.log(`RESULT:${JSON.stringify(result)}`);
