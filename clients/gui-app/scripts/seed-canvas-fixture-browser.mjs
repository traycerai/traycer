#!/usr/bin/env bun

/**
 * Drive the development-only canvas fixture bridge over CDP.
 *
 * This script intentionally has no package dependencies. Run it with Bun while
 * the desktop development stack is listening on its remote-debugging port.
 * See ../src/dev/README.md for commands, mutations, and cleanup guarantees.
 */

const cdpPort = Number(process.env.CDP_PORT ?? 37723);
const targetPrefix = process.env.TARGET ?? null;
const command = process.argv[2] ?? "inspect";
const listUrl = `http://127.0.0.1:${cdpPort}/json/list`;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;

    const failPending = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };

    socket.addEventListener("error", () => {
      const error = new Error("CDP WebSocket failed");
      failPending(error);
      reject(error);
    });
    socket.addEventListener("close", (event) => {
      failPending(new Error(`CDP WebSocket closed (${event.code})`));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        request.reject(new Error(JSON.stringify(message.error)));
      } else {
        request.resolve(message.result);
      }
    });
    socket.addEventListener("open", async () => {
      const send = (method, params = {}) =>
        new Promise((requestResolve, requestReject) => {
          const id = ++nextId;
          pending.set(id, { resolve: requestResolve, reject: requestReject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      try {
        const windowResponse = await send("Runtime.evaluate", {
          expression: "window",
        });
        const windowObjectId = windowResponse.result.objectId;
        if (windowObjectId === undefined) {
          reject(new Error("CDP did not return the page global object"));
          return;
        }
        const callBridge = async (method, args = []) => {
          const response = await send("Runtime.callFunctionOn", {
            objectId: windowObjectId,
            functionDeclaration: `function(method,args){
            const bridge=Reflect.get(this,"__traycerSeedFixture");
            if(bridge===undefined) return {state:"ABSENT"};
            if(method==="__inspect") {
              const required=["listTabs","seed","measure","roundTrip","teardown","restoreScroll","seedHeader","measureHeader","teardownHeader","seedDraft","teardownDrafts","purgeSeeded","fingerprint"];
              const missing=required.filter((key)=>typeof bridge[key]!=="function");
              if(missing.length>0) return {state:"STALE",missing};
              return {state:"CURRENT",sentinel:bridge.sentinel,tabs:bridge.listTabs()};
            }
            const operation=bridge[method];
            if(typeof operation!=="function") throw new Error("Unknown fixture bridge operation");
            return operation(...args);
          }`,
            arguments: [{ value: method }, { value: args }],
            returnByValue: true,
            awaitPromise: true,
          });
          if (response.exceptionDetails !== undefined) {
            throw new Error(
              response.exceptionDetails.exception?.description ??
                JSON.stringify(response.exceptionDetails),
            );
          }
          return response.result.value;
        };
        resolve({
          callBridge,
          close: () => socket.close(),
          send,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function readPageTargets() {
  let response;
  try {
    response = await fetch(listUrl);
  } catch (error) {
    throw new Error(
      `Cannot reach CDP at ${listUrl}. Start the desktop development stack first.`,
      { cause: error },
    );
  }
  if (!response.ok)
    throw new Error(`CDP target list returned ${response.status}`);
  return (await response.json()).filter((target) => target.type === "page");
}

async function inspectTarget(target) {
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    const capability = await client.callBridge("__inspect");
    return { capability, client, target };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function discoverCurrentTargets() {
  const targets = await readPageTargets();
  const matches = [];
  for (const target of targets) {
    if (targetPrefix !== null && !target.id.startsWith(targetPrefix)) continue;
    const inspected = await inspectTarget(target);
    if (inspected.capability.state === "CURRENT") matches.push(inspected);
    else inspected.client.close();
  }
  if (matches.length === 0) {
    const qualifier =
      targetPrefix === null ? "" : ` matching TARGET=${targetPrefix}`;
    throw new Error(
      `No page${qualifier} has a current fixture bridge. Restart the dev stack after enabling the seeder.`,
    );
  }
  return matches;
}

function targetSummary(entry) {
  const tabs = entry.capability.tabs ?? [];
  const tiles = tabs.reduce((total, tab) => total + tab.tileCount, 0);
  return `${entry.target.id.slice(0, 8)} tabs=${tabs.length} tiles=${tiles}`;
}

function pickSeedTarget(entries) {
  const explicitTabId = process.env.TAB_ID ?? null;
  const candidates = entries.flatMap((entry) =>
    (entry.capability.tabs ?? []).map((tab) => ({ entry, tab })),
  );
  const selected =
    (explicitTabId === null
      ? null
      : candidates.find(
          (candidate) => candidate.tab.tabId === explicitTabId,
        )) ?? candidates.sort((a, b) => b.tab.tileCount - a.tab.tileCount)[0];
  if (selected === undefined) {
    throw new Error(
      "No seedable epic canvas is open. Open an epic tab and retry.",
    );
  }
  return selected;
}

async function closeExcept(entries, keep) {
  for (const entry of entries) {
    if (entry !== keep) entry.client.close();
  }
}

async function inspect() {
  const entries = await discoverCurrentTargets();
  for (const entry of entries) {
    console.log(targetSummary(entry));
    for (const tab of entry.capability.tabs ?? []) {
      console.log(
        `  tab=${tab.tabId} epic=${tab.epicId || "(draft)"} panes=${tab.paneCount} tiles=${tab.tileCount}`,
      );
    }
    entry.client.close();
  }
}

async function seedCanvas() {
  const entries = await discoverCurrentTargets();
  const { entry, tab } = pickSeedTarget(entries);
  await closeExcept(entries, entry);
  const spec = {
    sourceTiles: Number(process.env.SOURCE_TILES ?? 6),
    targetTiles: Number(process.env.TARGET_TILES ?? 2),
    twoGroups: process.env.TWO_GROUPS !== "false",
    requireAutoScrollOverflow: process.env.REQUIRE_OVERFLOW !== "false",
  };
  const hostId = process.env.SEED_HOST_ID ?? "seed-host";
  console.log(`target=${entry.target.id} tab=${tab.tabId}`);
  console.log(
    `before=${await entry.client.callBridge("fingerprint", [tab.tabId])}`,
  );
  const seed = await entry.client.callBridge("seed", [tab.tabId, spec, hostId]);
  await sleep(1_200);
  const roundTrip = await entry.client.callBridge("roundTrip", [tab.tabId]);
  const measurement = await entry.client.callBridge("measure", [
    tab.tabId,
    spec.requireAutoScrollOverflow,
  ]);
  console.log(JSON.stringify({ seed, roundTrip, measurement }, null, 2));
  entry.client.close();
  if (!seed.ok || !roundTrip.ok || !measurement.ok) process.exitCode = 1;
}

async function seedHeader() {
  const entries = await discoverCurrentTargets();
  const { entry, tab } = pickSeedTarget(entries);
  await closeExcept(entries, entry);
  const count = Number(process.env.HEADER_TABS ?? 5);
  const report = await entry.client.callBridge("seedHeader", [
    count,
    tab.epicId,
  ]);
  await sleep(1_000);
  const measurement = await entry.client.callBridge("measureHeader");
  console.log(`target=${entry.target.id} epic=${tab.epicId}`);
  console.log(JSON.stringify({ report, measurement }, null, 2));
  entry.client.close();
  if (!report.ok) process.exitCode = 1;
}

async function seedDraft() {
  const entries = await discoverCurrentTargets();
  const entry = entries[0];
  await closeExcept(entries, entry);
  const report = await entry.client.callBridge("seedDraft");
  console.log(`target=${entry.target.id}`);
  console.log(JSON.stringify(report, null, 2));
  entry.client.close();
  if (!report.ok) process.exitCode = 1;
}

async function cleanup() {
  const entries = await discoverCurrentTargets();
  let restoredCanvas = 0;
  let removedHeaders = 0;
  let removedDrafts = 0;
  let failures = 0;
  for (const entry of entries) {
    const teardown = await entry.client.callBridge("teardown");
    const drafts = await entry.client.callBridge("teardownDrafts");
    const purge = await entry.client.callBridge("purgeSeeded");
    const structural = { teardown, drafts, purge };
    await sleep(1_000);
    const scroll = await entry.client.callBridge("restoreScroll");
    if (structural.teardown.ok) restoredCanvas += 1;
    removedHeaders += structural.purge.removed.length;
    removedDrafts += structural.drafts;
    // A window with no seeded canvas has no captured scroll state. That is a
    // no-op, not a cleanup failure. A real restore must itself succeed.
    if (structural.teardown.ok && !scroll.ok) failures += 1;
    console.log(
      `${entry.target.id.slice(0, 8)} canvas=${structural.teardown.ok ? "restored" : "none"} headers=${structural.purge.removed.length} drafts=${structural.drafts} scroll=${structural.teardown.ok ? (scroll.ok ? "restored" : "FAILED") : "none"}`,
    );
    entry.client.close();
  }
  console.log(
    `cleanup targets=${entries.length} canvases=${restoredCanvas} headers=${removedHeaders} drafts=${removedDrafts}`,
  );
  if (failures > 0) process.exitCode = 1;
}

const commands = {
  cleanup,
  inspect,
  "seed-canvas": seedCanvas,
  "seed-draft": seedDraft,
  "seed-header": seedHeader,
};

const run = commands[command];
if (run === undefined) {
  console.error(
    `Unknown command ${JSON.stringify(command)}. Use inspect, seed-canvas, seed-header, seed-draft, or cleanup.`,
  );
  process.exit(2);
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
