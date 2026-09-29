// Regression for `cdp-client.mjs`, the CDP client every browser driver talks
// over: when Chrome dies with a command in flight, that command must REJECT,
// and a command sent after the socket is gone must reject at once. The copies
// this module replaced had no `close` handler, so a Chrome crash left `send()`
// pending forever and the driver - spawned by `run-browser-regressions.ts`
// with no timeout - held the CI job instead of failing it.
//
// It needs a real DevTools socket to die under it, so it drives real headless
// Chrome (via `chrome-launcher.mjs`, like every driver), parks a command that
// Chrome will never answer - an evaluation of a promise that never settles -
// and then kills Chrome's whole process tree. Before `cdp-client.mjs` existed,
// the same sequence against a driver's local copy was still pending 8s later.
// First, while Chrome is alive, it checks the event half: `on` delivers and
// its unsubscribe stops delivery (ablating either one turns this red).
//
// It also covers `openTabSession`, the session that moves to a fresh tab per
// fixture load: a real renderer crash (`Page.crash`) marks the session
// crashed, `freshTab()` resets that, keeps the session's `on` handlers and
// answers commands again, and once Chrome is gone `close()` still settles
// promptly rather than rejecting, so a driver's `finally` goes on to clean up.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { connectCdp, openTabSession } from "./cdp-client.mjs";
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

  // `on` delivers an event's params, and stops once unsubscribed. Chrome
  // sends `Runtime.consoleAPICalled` before it answers the evaluate that
  // logged it, so each check can read the handler right after the send.
  const logged = [];
  const unsubscribe = client.on("Runtime.consoleAPICalled", (params) => {
    logged.push(params.args[0]?.value);
  });
  await client.send("Runtime.evaluate", { expression: "console.log('a')" });
  unsubscribe();
  await client.send("Runtime.evaluate", { expression: "console.log('b')" });
  assert.deepEqual(
    logged,
    ["a"],
    "on() must deliver the event while subscribed and nothing after",
  );

  // A session's tab crash is its own state, and a fresh tab starts clean.
  const session = await openTabSession(launched.devtoolsHttpUrl);
  const sessionLogged = [];
  session.on("Runtime.consoleAPICalled", (params) => {
    sessionLogged.push(params.args[0]?.value);
  });
  await session.send("Page.enable");
  // The crashed renderer never answers this command; only its events matter.
  session.send("Page.crash").catch(() => {});
  const crashDeadline = Date.now() + SETTLE_DEADLINE_MS;
  while (!session.crashed() && Date.now() < crashDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    session.crashed(),
    `a renderer crash must mark the session crashed within ${SETTLE_DEADLINE_MS}ms`,
  );
  await session.freshTab();
  assert.equal(
    session.crashed(),
    false,
    "a fresh tab must not inherit the crashed tab's state",
  );
  await session.send("Runtime.enable");
  await session.send("Runtime.evaluate", {
    expression: "console.log('fresh')",
  });
  assert.deepEqual(
    sessionLogged,
    ["fresh"],
    "a handler registered on the session must keep firing on the fresh tab",
  );

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

  // Chrome is gone: disposing of the session must settle, not reject, and
  // not wait on the dead endpoint.
  const closeStarted = Date.now();
  const closeOutcome = await Promise.race([
    session.close().then(
      () => "resolved",
      (error) => `rejected: ${error.message}`,
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve("pending"), SETTLE_DEADLINE_MS);
    }),
  ]);
  assert.equal(
    closeOutcome,
    "resolved",
    `closing a session after Chrome died must resolve, not ${closeOutcome}`,
  );
  const closeMs = Date.now() - closeStarted;

  console.log(
    `CDP client regression passed: session crash marked, reset by a fresh tab, handler carried over, closed ${String(closeMs)}ms after Chrome died; events delivered until unsubscribed; in-flight command ${outcome.message}; command after close ${afterClose}`,
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
