// Regression for `cdp-client.mjs`, the CDP client every browser driver talks
// over: when Chrome dies with a command in flight, that command must REJECT,
// and a command sent after the socket is gone must reject at once. The copies
// this module replaced had no `close` handler, so a Chrome crash left `send()`
// pending forever and the driver - spawned by `run-tests.ts` with no timeout -
// held the CI job instead of failing it.
//
// It needs a real DevTools socket to die under it, so it drives real headless
// Chrome (via `chrome-launcher.mjs`, like every driver), parks a command that
// Chrome will never answer - an evaluation of a promise that never settles -
// and then kills Chrome's whole process tree. Before `cdp-client.mjs` existed,
// the same sequence against a driver's local copy was still pending 8s later.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { connectCdp } from "./cdp-client.mjs";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";

// Far above the time a closed socket takes to surface (milliseconds), far
// below the client's own 30s per-command ceiling - so a pass can only come
// from the close path, never from the command timeout.
const SETTLE_DEADLINE_MS = 8_000;

const chromePath = await findChrome("the CDP client regression");
let launched;
try {
  launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-cdp-client-",
    [],
  );
  const targets = await (
    await fetch(new URL("/json/list", launched.devtoolsHttpUrl))
  ).json();
  const page = targets.find((target) => target.type === "page");
  assert.ok(page !== undefined, "headless Chrome must expose a page target");
  const client = await connectCdp(page.webSocketDebuggerUrl);
  await client.send("Runtime.enable");

  const inFlight = client
    .send("Runtime.evaluate", {
      expression: "new Promise(() => {})",
      awaitPromise: true,
    })
    .then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", message: error.message }),
    );
  await terminateProcessTree(launched.chrome);
  const outcome = await Promise.race([
    inFlight,
    new Promise((resolve) => {
      setTimeout(() => resolve({ kind: "pending" }), SETTLE_DEADLINE_MS);
    }),
  ]);
  assert.equal(
    outcome.kind,
    "rejected",
    `a command in flight when Chrome dies must reject, not ${outcome.kind === "pending" ? `stay pending for ${SETTLE_DEADLINE_MS}ms` : "resolve"}`,
  );
  assert.match(outcome.message, /CDP socket (closed|error)/);

  const afterClose = await client
    .send("Runtime.evaluate", { expression: "1" })
    .then(
      () => "resolved",
      (error) => `rejected: ${error.message}`,
    );
  assert.match(
    afterClose,
    /^rejected: CDP socket (closed|error)/,
    `a command sent after the socket is gone must reject at once (got ${afterClose})`,
  );

  console.log(
    `CDP client regression passed: in-flight command ${outcome.message}; command after close ${afterClose}`,
  );
} catch (error) {
  console.error("CDP CLIENT REGRESSION FAILED:", error);
  process.exitCode = 1;
} finally {
  if (launched !== undefined) {
    await terminateProcessTree(launched.chrome);
    await rm(launched.profilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}
