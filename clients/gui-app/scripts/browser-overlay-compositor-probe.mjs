// Ticket 09 (specs/browser-overlay-coexistence/tickets/09-cdp-compositor-probe.md):
// the only check in the epic that can see a composited frame, and the only
// one that can settle the freshness/DPR unknowns tickets 03/04 were built on.
//
// Unlike `diff-edit-browser-regression.mjs` / `pierre-tree-zoom-browser-
// regression.mjs` (this driver's precedent for CDP plumbing, arg style, and
// reporting voice), this script does NOT spawn its own Chrome/Electron. It
// attaches to an ALREADY-RUNNING `make dev-desktop` instance, because the
// thing under test - the real occlusion coordinator racing the real
// compositor - only exists there. A self-contained fixture harness (a bare
// `<div>` stand-in, a synthetic overlay) is exactly the blind spot invariant
// 4's regression shipped from (see ticket 08 / spec "Test bar" item 1); this
// probe is the layer that watches the real Radix portals and the real
// WebContentsView instead.
//
// PRECONDITION: the target instance must already have an epic canvas open
// with at least one native browser tile visible (agent-browser-tile-*), in a
// split pane (a `[data-testid="split-resize-handle"]` must exist - the
// CONSTANTS motion-rest measurement drags it). Dev exploration turned up no
// stable CDP hook that opens a browser tile from scratch - it only exists as
// a side effect of clicking a link in chat/terminal output or an in-tile
// "new tab", both of which need an existing tile or a signed-in chat session
// to originate from. Scripting that whole flow here would make the probe as
// fragile as the product surface it exists to test. Set up the scenario by
// hand once per run; the probe takes it from there.
//
// CONFIRMED LIVE (superseding the original "UNVERIFIED" note above ticket
// 09's first run): the tile's guest WebContentsView DOES show up as its own
// `/json/list` page target on the same CDP port - `resolveGuestTarget` finds
// it by exclusion (neither the renderer app target nor a devtools frontend),
// which works both before and after this probe's own navigation.
//
// CONFIRMED LIVE, and load-bearing for how EDGE sampling works below:
// `Page.captureScreenshot` on the RENDERER target does NOT show the native
// WebContentsView at all - it reads back a flat hole (observed: a solid
// rgb(15,15,15)) where the tile's native content should be. Electron
// composites a `WebContentsView` into the OS window, not into the
// renderer's own CDP screencasting/screenshot pipeline, so CDP screenshots
// are structurally blind to the exact thing EDGE 1/2 need to see (native
// pixels vs. overlay/stand-in pixels). EDGE sampling therefore goes through
// an OS-level `screencapture -l <windowId>` capture instead (see
// `resolveAppWindow` / `captureScreenshot`), which IS the real compositor
// output. This needs macOS Screen Recording permission granted to whatever
// process runs this script - `PREFLIGHT` fails loud and named if that is
// missing, rather than reporting phantom "stand-in-gap" violations from an
// empty capture. The renderer-target CDP connection (`client`) is still used
// for driving input, waiting on DOM state, and reading the stand-in `<img>`
// directly for FRESHNESS (that element genuinely lives in the renderer DOM,
// so CDP sees it fine) - only the compositor-truth EDGE sampling moved.
//
// ENVIRONMENT DISCIPLINE (ticket 09's "Environment discipline" section):
//   - `make dev-desktop` needs the machine's dev-desktop permission
//     coordinator's GRANTED before it starts, and a RELEASED after - this
//     script assumes that lease is already held by whoever launched the
//     instance it is about to attach to. It never starts or stops the stack.
//   - The dev-desktop CDP port is SLOT-SCOPED, not the shared 9222 - identify
//     the right instance by its CDP User-Agent worktree tag, never by a bare
//     port or a broad `pgrep`/`ps` match (a broad match has killed a live
//     session before). `--port` + `--worktree-tag` below are both required
//     for exactly this reason: the port alone is not proof of identity.
//   - The dev-desktop watcher rebuilds the host on worktree file writes.
//     Never run this probe while code in the worktree is being edited -
//     serialize: land the change, let the relaunch settle, THEN gather
//     evidence. Evidence collected mid-rebuild is not evidence.
//   - A CDP-driven window is usually occluded (`visibilityState: "hidden"`),
//     which starves rAF entirely - this probe's whole point is composited
//     frames, so it brings the window genuinely frontmost with `osascript`
//     before doing anything (`Page.bringToFront` changes focus, not
//     visibility, and is not enough). macOS only, matching the rest of the
//     dev-desktop tooling this probe attaches to.
//
// SELF-CHECK MODE (`--sabotage=paint-ack|restore-ack`, ticket 09
// "Validation"): this flag does not patch any source itself - patching a gate
// off from inside the probe that is supposed to prove the gate works would
// make the self-check circular. Instead: the OPERATOR temporarily disables
// the named gate in source (paint-ack = the entry stand-in-before-park
// handshake; restore-ack = the exit native-first-frame-before-unmount
// handshake), rebuilds, and runs this probe exactly as normal - the probe
// carries no sabotage-specific logic. `--sabotage` only changes the report
// header, so a red run under it reads as "the mechanism, deliberately
// broken" instead of an unexplained failure:
//   --sabotage=paint-ack    -> expect EDGE 1 (hide) to go red: native-above-
//                              overlay or a stand-in gap on entry.
//   --sabotage=restore-ack  -> expect EDGE 2 (restore) to go red: the native
//                              view repainting before the stand-in yields.
// A clean run with `--sabotage` set and nothing going red means the probe
// did not actually exercise the disabled gate - fix the probe, not the note.
//
// RELOAD THE RENDERER AFTER EDITING THE GATE - Vite HMR is NOT enough.
// CONFIRMED LIVE, and it silently invalidated three runs before it was
// caught: after saving a change to `browser-overlay-coordinator-bridge.tsx`
// the HMR update is applied to the module, but the coordinator's already-
// running `useEffect` closure keeps executing the OLD code, so the gate is
// still intact while the source says otherwise. The canary is a maximal
// break (suppress `setBrowserViewSnapshot` entirely): with it "live" via
// HMR only, a stand-in `<img>` still mounts under an open overlay. Force a
// real reload (CDP `Page.reload` on the renderer target, or the app's own
// reload) and re-check that canary before believing any sabotage result.
//
// Arg surface:
//   --port=<n>            (required) the target's CDP port, from the launch
//                          log or the coordinator lease, e.g. 24752.
//   --worktree-tag=<str>  (required) the worktree label baked into the CDP
//                          User-Agent, e.g. "feat-in-app-browser-2" for
//                          "TraycerDev—feat-in-app-browser-2/0.0.0". Refused
//                          to run without a match - see dev-desktop CDP
//                          port note above.
//   --sabotage=<mode>     (optional) "paint-ack" | "restore-ack", see above.
//   --samples=<n>          (optional, default 24) sample count for the
//                          click-to-standin and motion-rest distributions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const GUEST_COLOR_INITIAL = { r: 255, g: 0, b: 255 }; // #ff00ff marker
const GUEST_COLOR_UPDATED = { r: 0, g: 255, b: 255 }; // #00ffff freshness marker
const COLOR_MATCH_TOLERANCE = 24; // per-channel, generous for PNG/JPEG-free lossless capture but tolerant of AA fringes
const EDGE_SAMPLE_WINDOW_MS = 600;
const EDGE_SAMPLE_INTERVAL_MS = 15;
// Long enough for the guest to repaint the flipped colour and for that paint
// to reach the compositor, short enough not to pad every edge cycle.
const GUEST_FLIP_SETTLE_MS = 300;

// A pixel further than this from BOTH markers is neither of them - a gap.
// Well inside the ~1.41 that separates the two markers themselves.
const MARKER_MATCH_DISTANCE = 0.35;

/**
 * The app process this run is driving, remembered so a capture that loses
 * the foreground mid-run can put it back. Another app taking focus is not
 * hypothetical on a shared dev machine (CONFIRMED LIVE: Slack stole it
 * mid-EDGE, the window went off-screen, and `screencapture -l` failed with
 * "could not create image from window") - and an off-screen window is void
 * as evidence anyway, since rAF is starved there.
 */
let frontmostPid = null;

const args = parseArgs(process.argv.slice(2));

let client;
try {
  await verifyWorktreeTag(args.port, args.worktreeTag);
  const target = await resolveAppTarget(args.port);
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");

  foregroundOwningProcess(args.port);
  await waitFor(
    client,
    "the dev-desktop window to report visible (osascript frontmost)",
    `document.visibilityState === "visible"`,
  );

  const tile = await locateTile(client);
  console.log(
    `[probe] using tile ${tile.testId} at ${JSON.stringify(tile.rect)}`,
  );

  // EDGE sampling reads the real OS compositor output, not a CDP screenshot
  // (see the header note) - resolve the app's own window once, up front, so
  // every later `screencapture -l <windowId>` targets the same window
  // without re-shelling out to Quartz per sample.
  const appWindow = resolveAppWindow(args.worktreeTag);
  console.log(
    `[probe] resolved app window ${appWindow.windowId} at ${JSON.stringify(appWindow.bounds)}`,
  );
  const dpr = await evaluate(client, "window.devicePixelRatio");

  await navigateTileToMarker(GUEST_COLOR_INITIAL, args.port, target.id);

  console.log("[probe] PREFLIGHT");
  await runPreflight(client, tile, appWindow, dpr);

  console.log("[probe] EDGE 1 - app-chrome dropdown over the tile");
  const guest = {
    port: args.port,
    rendererTargetId: target.id,
    color: GUEST_COLOR_INITIAL,
  };
  const edge1 = await runOverlayEdgePair(client, tile, appWindow, dpr, guest, {
    open: () => openDropdown(client),
    close: () => closeOverlayWithEscape(client),
  });
  assertNoEdgeViolation("EDGE 1 (dropdown)", edge1);

  console.log("[probe] EDGE 2 - settings dialog + nested select");
  const edge2 = await runOverlayEdgePair(client, tile, appWindow, dpr, guest, {
    open: () => openSettingsNestedSelect(client),
    close: () => closeSettingsDialog(client),
  });
  assertNoEdgeViolation("EDGE 2 (settings + nested select)", edge2);

  console.log("[probe] FRESHNESS");
  await assertStandInFreshness(client, guest);

  console.log("[probe] DPR");
  await reportDpr(client);

  console.log("[probe] CONSTANTS");
  await reportClickToStandInLatency(client, args.samples);
  await reportMotionRest(client, args.samples);

  // A clean run under --sabotage is not a pass: the operator deliberately
  // disabled a gate this probe exists to catch, so reaching here with
  // nothing red means the probe never actually exercised it - that is
  // itself a probe bug (or a wrong `--sabotage` mode for what was really
  // disabled), and must fail loud rather than report "passed".
  if (args.sabotage !== null) {
    throw new Error(
      `--sabotage=${args.sabotage} was set but every check above passed cleanly - the probe did not exercise the disabled gate. Fix the probe (or the sabotage), not this message.`,
    );
  }

  console.log("browser overlay compositor probe passed");
} finally {
  client?.close();
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Map();
  for (const entry of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(entry);
    if (match === null) {
      throw new Error(`Unrecognized argument: ${entry}`);
    }
    flags.set(match[1], match[2]);
  }
  const port = Number(flags.get("port"));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("--port=<n> is required (the target instance's CDP port)");
  }
  const worktreeTag = flags.get("worktree-tag");
  if (typeof worktreeTag !== "string" || worktreeTag.length === 0) {
    throw new Error(
      "--worktree-tag=<str> is required - identify the instance by its CDP User-Agent tag, never a bare port",
    );
  }
  const sabotage = flags.get("sabotage") ?? null;
  if (
    sabotage !== null &&
    sabotage !== "paint-ack" &&
    sabotage !== "restore-ack"
  ) {
    throw new Error('--sabotage must be "paint-ack" or "restore-ack"');
  }
  const samples = flags.has("samples") ? Number(flags.get("samples")) : 24;
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new Error("--samples=<n> must be a positive integer");
  }
  return { port, worktreeTag, sabotage, samples };
}

// ---------------------------------------------------------------------------
// Instance identification (never a bare port - see header)
// ---------------------------------------------------------------------------

async function verifyWorktreeTag(port, worktreeTag) {
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(
      `Could not reach ${versionUrl}: ${response.status}. Is a dev-desktop instance listening on --port=${port}?`,
    );
  }
  const version = await response.json();
  const userAgent = String(version["User-Agent"] ?? "");
  if (!userAgent.toLowerCase().includes(worktreeTag.toLowerCase())) {
    throw new Error(
      `Refusing to drive port ${port}: its CDP User-Agent ("${userAgent}") does not contain --worktree-tag="${worktreeTag}". ` +
        "A bare port match is exactly what has killed the wrong live session before - pass the tag from the instance you actually mean.",
    );
  }
  console.log(
    `[probe] confirmed worktree tag "${worktreeTag}" in User-Agent: ${userAgent}`,
  );
}

async function resolveAppTarget(port) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const response = await fetch(listUrl);
  if (!response.ok) {
    throw new Error(
      `Could not list CDP targets at ${listUrl}: ${response.status}`,
    );
  }
  const targets = await response.json();
  const pageTargets = targets.filter(
    (target) =>
      target.type === "page" && !String(target.url).startsWith("devtools://"),
  );
  // The tile's guest is a page target too, and `/json/list` has listed it
  // FIRST on a live run (observed 2026-09-02) - so a bare `pageTargets[0]`
  // fallback attaches this whole probe to the guest and every renderer DOM
  // lookup below then fails as "no open browser tile". dev-desktop serves
  // the renderer on its slot's own port (e.g. 31673), not Vite's default
  // 5173, so identify it as the local one rather than by a fixed port.
  const rendererTarget =
    pageTargets.find((target) =>
      String(target.url).includes("localhost:5173"),
    ) ??
    pageTargets.find((target) =>
      /^https?:\/\/(localhost|127\.0\.0\.1):\d+\//.test(String(target.url)),
    ) ??
    pageTargets[0];
  if (rendererTarget === undefined) {
    throw new Error(
      `No page target found on port ${port}: ${JSON.stringify(targets)}`,
    );
  }
  if (typeof rendererTarget.webSocketDebuggerUrl !== "string") {
    throw new Error("Resolved app target has no webSocketDebuggerUrl");
  }
  return rendererTarget;
}

/**
 * Finds the PID owning the CDP port via `lsof` (not `ps` argv - per the
 * dev-desktop CDP notes, System Events needs the process that actually
 * LISTENS on the port, and argv alone is not reliable for that), then asks
 * macOS to bring it frontmost. `Page.bringToFront` only changes focus, not
 * `visibilityState`, and CDP-driven dev-desktop windows are occluded by
 * default - see the header comment.
 */
function raiseFrontmost() {
  if (frontmostPid === null) return;
  execFileSync("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of (first process whose unix id is ${frontmostPid}) to true`,
  ]);
}

function foregroundOwningProcess(port) {
  const lsofOutput = execFileSync(
    "lsof",
    ["-iTCP:" + String(port), "-sTCP:LISTEN", "-n", "-P", "-t"],
    { encoding: "utf8" },
  ).trim();
  const pid = Number(lsofOutput.split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `Could not resolve a PID listening on port ${port} via lsof`,
    );
  }
  frontmostPid = pid;
  raiseFrontmost();
  console.log(
    `[probe] brought pid ${pid} (listening on ${port}) frontmost via osascript`,
  );
}

/**
 * Resolves the app's own on-screen window via Quartz's window list (a small
 * inline `python3` + pyobjc `Quartz` lookup - `screencapture -l <windowId>`
 * needs a `CGWindowID`, and nothing on the CDP side of this script can
 * produce one). Matched by `--worktree-tag`, the same identity the CDP
 * User-Agent check already uses, against the window's owner/title - never a
 * bare "first window found" guess, for the same reason the port alone is
 * never proof of identity elsewhere in this script.
 */
function resolveAppWindow(worktreeTag) {
  const script = `
import Quartz, json, sys
tag = sys.argv[1].lower()
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
)
matches = []
for w in windows:
    owner = str(w.get("kCGWindowOwnerName") or "")
    name = str(w.get("kCGWindowName") or "")
    bounds = w.get("kCGWindowBounds") or {}
    if tag in (owner + " " + name).lower() and bounds.get("Width", 0) > 0:
        matches.append({
            "windowId": w.get("kCGWindowNumber"),
            "owner": owner,
            "name": name,
            # Quartz hands back an __NSDictionaryI, which json.dumps refuses.
            "bounds": {k: bounds[k] for k in ("X", "Y", "Width", "Height")},
        })
print(json.dumps(matches))
`;
  let output;
  try {
    output = execFileSync("python3", ["-c", script, worktreeTag], {
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(
      `Could not resolve the app window via Quartz - is pyobjc's Quartz module installed (\`pip3 install pyobjc-framework-Quartz\`)? ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const matches = JSON.parse(output);
  if (matches.length === 0) {
    throw new Error(
      `No on-screen window found matching --worktree-tag="${worktreeTag}" via Quartz CGWindowListCopyWindowInfo`,
    );
  }
  // Largest by area if more than one matched - the real app window, never a
  // stray panel/tooltip sharing the same owner process.
  const widest = matches.reduce((best, candidate) => {
    const area = (candidate.bounds.Width ?? 0) * (candidate.bounds.Height ?? 0);
    const bestArea = (best.bounds.Width ?? 0) * (best.bounds.Height ?? 0);
    return area > bestArea ? candidate : best;
  });
  return {
    windowId: widest.windowId,
    bounds: {
      x: widest.bounds.X ?? 0,
      y: widest.bounds.Y ?? 0,
      width: widest.bounds.Width ?? 0,
      height: widest.bounds.Height ?? 0,
    },
  };
}

/**
 * The real OS compositor output for the app window - unlike a CDP
 * `Page.captureScreenshot` on the renderer target, this genuinely shows the
 * native `WebContentsView` (see the header note: CDP screenshots read back a
 * flat hole where it should be). Requires macOS Screen Recording permission
 * for whatever process runs this script; `PREFLIGHT` below checks that
 * up front with a named cause rather than letting every later EDGE sample
 * silently see an empty/black capture.
 */
async function captureScreenshot(windowId) {
  const file = path.join(tmpdir(), `browser-overlay-probe-${randomUUID()}.png`);
  try {
    // `-o` (no window shadow) is load-bearing, not cosmetic: without it
    // macOS pads the capture with the drop-shadow region (CONFIRMED LIVE:
    // 3248x2122 for a 1512x949 CSS window at dpr 2, vs. the 3024x1898 the
    // `cssPx * dpr` mapping in `samplePixel` assumes), which shifts every
    // sample point by ~112px and reports phantom violations.
    execFileSync("screencapture", ["-x", "-o", "-l", String(windowId), file]);
  } catch (firstError) {
    // "could not create image from window" means the window is no longer on
    // screen - another app took focus mid-run. Put ours back and try once
    // more, rather than failing a whole probe run over one stolen frame.
    // 250ms is not enough here: when the app sits on another macOS Space,
    // raising it plays a Space-switch animation and the window is not
    // capturable until that finishes (CONFIRMED LIVE: a raise plus 2s makes
    // `kCGWindowIsOnscreen` true again and the capture succeed, while a
    // raise plus 250ms fails exactly as before).
    let retryError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      raiseFrontmost();
      await delay(1_500);
      try {
        execFileSync("screencapture", [
          "-x",
          "-o",
          "-l",
          String(windowId),
          file,
        ]);
        retryError = null;
        break;
      } catch (error) {
        retryError = error;
      }
    }
    if (retryError !== null) {
      throw new Error(
        `screencapture failed to capture window ${windowId} even after re-raising it frontmost - ` +
          "something else on this machine keeps taking focus, and an off-screen window is void as evidence " +
          `(rAF is starved there): ${
            retryError instanceof Error
              ? retryError.message
              : String(retryError)
          } (first attempt: ${
            firstError instanceof Error
              ? firstError.message
              : String(firstError)
          })`,
      );
    }
  }
  let buffer;
  try {
    buffer = await readFile(file);
  } finally {
    await rm(file, { force: true });
  }
  if (buffer.length === 0) {
    throw new Error(
      `screencapture produced an empty file for window ${windowId} - this is the "Screen Recording permission missing" ` +
        "symptom: grant it to whatever process is running this script in System Settings > Privacy & Security > " +
        "Screen Recording, then restart that process (permission is not picked up live).",
    );
  }
  return { base64: buffer.toString("base64"), timestamp: performance.now() };
}

// ---------------------------------------------------------------------------
// CDP plumbing - same shape as diff-edit-browser-regression.mjs /
// pierre-tree-zoom-browser-regression.mjs
// ---------------------------------------------------------------------------

async function connectCdp(url) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const connectTimer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to the CDP socket"));
    }, 15_000);
    socket.addEventListener("error", () =>
      reject(new Error("CDP socket failed")),
    );
    socket.addEventListener("close", () => {
      clearTimeout(connectTimer);
      const failure = new Error("CDP socket closed before the request settled");
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      reject(failure);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error === undefined) request.resolve(message.result);
      else request.reject(new Error(message.error.message));
    });
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}) {
          return new Promise((requestResolve, requestReject) => {
            const id = ++nextId;
            pending.set(id, { resolve: requestResolve, reject: requestReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser evaluation failed",
    );
  }
  return response.result.value;
}

async function waitFor(client, label, expression, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(client, x, y, clickCount = 1) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let count = 1; count <= clickCount; count += 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: count,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: count,
    });
  }
}

async function pressKey(client, key, options = {}) {
  const base = {
    key,
    code: options.code ?? key,
    windowsVirtualKeyCode: options.keyCode ?? 0,
    nativeVirtualKeyCode: options.keyCode ?? 0,
    modifiers: options.modifiers ?? 0,
  };
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ---------------------------------------------------------------------------
// Tile / overlay location
// ---------------------------------------------------------------------------

async function locateTile(client) {
  const tile = await evaluate(
    client,
    `(() => {
      const host = document.querySelector('[data-testid^="agent-browser-tile-"]');
      if (host === null) return null;
      const surface = host.querySelector('[data-browser-view-surface]');
      if (surface === null) return null;
      const rect = surface.getBoundingClientRect();
      return {
        testId: host.getAttribute("data-testid"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    })()`,
  );
  if (tile === null) {
    throw new Error(
      'No open browser tile found (looked for [data-testid^="agent-browser-tile-"] with a [data-browser-view-surface] child). ' +
        "This probe requires a tile to already be open in the target instance - see the PRECONDITION note in the header comment.",
    );
  }
  return tile;
}

/**
 * Navigates the tile's guest WebContentsView directly to the marker `data:`
 * URL over its OWN CDP target, via `Page.navigate` - not by driving the
 * visible address bar. `Page.navigate` with a `data:` URL is allowed at the
 * CDP level; what the app actually blocks is typing one into the omnibox
 * (an XSS/spoofing guard on the visible address field), which is a
 * UI-input-path restriction this never goes through. Resolving the guest
 * target first (by exclusion, see `resolveGuestTarget`) and polling its
 * reported URL replaces both the brittle char-by-char keystroke loop and
 * the fixed `delay(500)` "settle" guess with the thing this probe actually
 * needs to know: has the navigation landed.
 */
async function navigateTileToMarker(color, port, rendererTargetId) {
  const dataUrl = markerDataUrl(color);
  const guestTarget = await resolveGuestTarget(port, rendererTargetId);
  const guestClient = await connectCdp(guestTarget.webSocketDebuggerUrl);
  try {
    await guestClient.send("Page.enable");
    await guestClient.send("Page.navigate", { url: dataUrl });
    await waitForTargetUrl(port, guestTarget.id, dataUrl);
  } finally {
    guestClient.close();
  }
}

function markerDataUrl(color) {
  const hex = rgbToHex(color);
  const html = `<!doctype html><html><body style="margin:0;background:${hex}"><div id="marker" style="position:fixed;inset:0;background:${hex}"></div></body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

function rgbToHex(color) {
  const channel = (value) => value.toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

// ---------------------------------------------------------------------------
// Preflight: fail loud and specific BEFORE sampling any edge, rather than
// letting a broken compositing/CDP assumption surface as a wall of edge
// violations further down that all trace back to one root cause.
// ---------------------------------------------------------------------------

/**
 * Two things every check below assumes: (1) the tile's guest WebContentsView
 * resolves as its own CDP target, and (2) `Page.captureScreenshot` on the
 * RENDERER target actually shows the native view's composited pixels (not a
 * blank/transparent hole - Electron's `WebContentsView` compositing into a
 * CDP screenshot is exactly the thing ticket 09 exists to settle live). A
 * failure here means every later EDGE/FRESHNESS check would report false
 * negatives (no violations, because nothing meaningful was ever sampled) -
 * so this fails loud and named instead of quietly falling through.
 */
async function runPreflight(client, tile, appWindow, dpr) {
  // (1) `screencapture` actually produces a real image - `captureScreenshot`
  // itself throws a named, permission-shaped error on an empty file, so a
  // successful call here already proves that half.
  let screenshot;
  try {
    screenshot = await captureScreenshot(appWindow.windowId);
  } catch (error) {
    throw new Error(
      `PREFLIGHT FAILED (screencapture not usable): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // (2) positive control: the guest's marker color is actually visible at
  // the tile's centre in that capture. `navigateTileToMarker` already
  // proved the guest CDP target resolves and accepted the navigation (it
  // throws otherwise) - what this adds is proof that the OS compositor
  // ACTUALLY shows the result, which is the one thing CDP cannot see (see
  // the header note) and the one thing every EDGE check below depends on.
  const center = {
    x: tile.rect.x + tile.rect.width / 2,
    y: tile.rect.y + tile.rect.height / 2,
  };
  const pixel = await samplePixel(
    client,
    screenshot.base64,
    center.x,
    center.y,
    dpr,
  );
  if (!colorsClose(pixel, GUEST_COLOR_INITIAL)) {
    throw new Error(
      `PREFLIGHT FAILED (native view not composited in the OS screencapture): sampled ` +
        `${JSON.stringify(pixel)} at the tile centre, expected ~${JSON.stringify(GUEST_COLOR_INITIAL)}. ` +
        "Every EDGE check below reads pixels out of this same OS-level capture mechanism - " +
        "if the native view is not showing up here, they cannot detect anything either way.",
    );
  }
  console.log(
    "[probe] PREFLIGHT: guest target navigated, screencapture works, and the marker color is visible at the tile centre",
  );
}

// ---------------------------------------------------------------------------
// Edge 1: app-chrome dropdown ("More browser controls" on the tile toolbar,
// anchored directly over the tile so its content is guaranteed to intersect)
// ---------------------------------------------------------------------------

async function openDropdown(client) {
  const point = await elementCenter(
    client,
    '[aria-label="More browser controls"]',
  );
  if (point === null) {
    throw new Error(
      'Could not find the tile toolbar dropdown trigger ([aria-label="More browser controls"])',
    );
  }
  // Two attempts, because a click that lands inside Radix's own dismiss
  // grace period (right after the previous menu closed on Escape) is
  // swallowed silently - the trigger never opens and the wait below just
  // times out. The CONSTANTS loop reopens this menu `--samples` times in a
  // row, so this is the common path, not an edge case.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const clickedAt = performance.now();
    await click(client, point.x, point.y);
    try {
      await waitFor(
        client,
        "the tile toolbar dropdown to open",
        openOverlayRectExpression(),
        attempt === 1 ? 500 : 15_000,
      );
      // The timestamp of the click that ACTUALLY opened the menu, so a
      // caller timing the occlusion round trip measures the round trip and
      // not a swallowed click plus this function's own retry budget.
      return clickedAt;
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(250);
    }
  }
  throw new Error(
    "unreachable: openDropdown exhausted its attempts without throwing",
  );
}

async function closeOverlayWithEscape(client) {
  await pressKey(client, "Escape", { code: "Escape", keyCode: 27 });
  await waitFor(
    client,
    "the overlay to fully close",
    `${openOverlayRectExpression()} === null`,
  );
}

// ---------------------------------------------------------------------------
// Edge 2: settings dialog + nested select (the settings-nested-select
// scenario named in the spec's real-Radix test bar item, ticket 08)
// ---------------------------------------------------------------------------

async function openSettingsNestedSelect(client) {
  // CONFIRMED LIVE: `[data-testid="user-menu-app-settings"]` is not in the
  // DOM at rest - it lives inside the user menu's dropdown content, which
  // does not mount until the menu trigger itself is opened.
  const userMenuPoint = await elementCenter(
    client,
    '[data-testid="user-menu-trigger"]',
  );
  if (userMenuPoint === null) {
    throw new Error(
      'Could not find the user menu trigger ([data-testid="user-menu-trigger"])',
    );
  }
  await click(client, userMenuPoint.x, userMenuPoint.y);
  await waitFor(
    client,
    "the user menu to open",
    `document.querySelector('[data-testid="user-menu-app-settings"]') !== null`,
  );

  const settingsButtonPoint = await elementCenter(
    client,
    '[data-testid="user-menu-app-settings"]',
  );
  if (settingsButtonPoint === null) {
    throw new Error(
      'Could not find the settings trigger ([data-testid="user-menu-app-settings"])',
    );
  }
  await click(client, settingsButtonPoint.x, settingsButtonPoint.y);
  await waitFor(
    client,
    "the settings dialog to open",
    `document.querySelector('[data-slot="dialog-content"]') !== null`,
  );

  const appearanceTabPoint = await elementCenter(
    client,
    '[data-testid="settings-sidebar-item-appearance"]',
  );
  if (appearanceTabPoint === null) {
    throw new Error(
      'Could not find the Appearance settings sidebar entry ([data-testid="settings-sidebar-item-appearance"])',
    );
  }
  await click(client, appearanceTabPoint.x, appearanceTabPoint.y);

  const selectPoint = await evaluate(
    client,
    `(() => {
      const trigger = document.querySelector('[aria-label="Minimap side"]');
      if (!(trigger instanceof HTMLElement)) return null;
      trigger.scrollIntoView({ block: "center" });
      const rect = trigger.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
  );
  if (selectPoint === null) {
    throw new Error(
      'Could not find the nested select ([aria-label="Minimap side"])',
    );
  }
  await click(client, selectPoint.x, selectPoint.y);
  await waitFor(
    client,
    "the nested select to open",
    openOverlayRectExpression(),
  );
}

async function closeSettingsDialog(client) {
  // First Escape collapses the open select, second closes the dialog itself
  // - both are overlays over the tile, so both edges get sampled by the
  // caller's before/after screenshots around this whole close() call.
  await pressKey(client, "Escape", { code: "Escape", keyCode: 27 });
  await delay(50);
  await pressKey(client, "Escape", { code: "Escape", keyCode: 27 });
  await waitFor(
    client,
    "the settings dialog to fully close",
    `document.querySelector('[data-slot="dialog-content"]') === null`,
  );
}

async function elementCenter(client, selector) {
  return await evaluate(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
  );
}

/** Any open Radix portal content (menu, listbox, dialog) - topmost wins. */
function openOverlayRectExpression() {
  return `(() => {
    const nodes = [...document.querySelectorAll('[data-state="open"][role]')]
      .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const top = nodes.at(-1);
    if (top === undefined) return null;
    const rect = top.getBoundingClientRect();
    // \`opacity\` rides along because a Radix portal is in the DOM with a
    // non-zero rect BEFORE its enter animation has painted anything: the
    // tile is legitimately visible through a still-transparent menu, and
    // the stand-in is a copy of the guest, so those frames are pixel-wise
    // indistinguishable from the native view genuinely painting above the
    // overlay. The native-above-overlay check only classifies opaque
    // frames for exactly that reason.
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      opacity: Number(getComputedStyle(top).opacity),
    };
  })()`;
}

/**
 * EVERY open Radix portal's rect, topmost last - not just the topmost one.
 * The gap check needs all of them as its avoid-region: a nested select over
 * the settings dialog makes the SELECT topmost, so avoiding only that leaves
 * the sample point free to land on the dialog behind it, and a tile pixel
 * read through a still-painted dialog reports as an empty tile (CONFIRMED
 * LIVE on the EDGE 2 restore edge: rgb(20,28,26), the dialog's own surface).
 */
function openOverlayRectsExpression() {
  return `[...document.querySelectorAll('[data-state="open"][role]')]
    .map((el) => el.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))`;
}

// ---------------------------------------------------------------------------
// Screenshot pixel decode (via an in-page <canvas> so this script never has
// to hand-roll a PNG decoder - the browser already has one; the DOM used to
// decode is always the renderer target's, regardless of whether the PNG
// itself came from that same CDP connection or an OS-level `screencapture`)
// ---------------------------------------------------------------------------

/**
 * Reads one pixel's RGBA out of a captured screenshot, given a CSS-px
 * coordinate and the `scale` (device pixel ratio) that maps CSS px to the
 * screenshot's own pixel grid - window bounds x DPR, not a ratio re-derived
 * from `window.innerWidth`: an OS-level window capture is not guaranteed to
 * be exactly the CDP viewport's own dimensions, so the scale has to come
 * from the caller, not be re-guessed here per image.
 */
async function samplePixel(client, base64, cssX, cssY, scale) {
  return await evaluate(
    client,
    `(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${base64}";
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = Math.round(${cssX} * ${scale});
      const py = Math.round(${cssY} * ${scale});
      const data = ctx.getImageData(px, py, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2] };
    })()`,
  );
}

function colorsClose(a, b, tolerance = COLOR_MATCH_TOLERANCE) {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

/**
 * Whether `pixel` is one of the guest markers, allowing for uniform
 * DIMMING - a modal dialog lays a semi-transparent scrim over the whole
 * window, so the tile outside the dialog's own rect shows the marker
 * darkened (CONFIRMED LIVE: rgb(170,9,170) for the #ff00ff marker under the
 * settings dialog's scrim). That is the guest showing correctly, not a gap.
 *
 * Compared by channel RATIO rather than absolute value, which is what
 * survives dimming: #ff00ff normalises to (1, ~0, 1) at any brightness,
 * while the two things a gap actually looks like do not - the app's own
 * background rgb(18,23,21) normalises to (0.78, 1, 0.91) and the parked
 * view's hole rgb(15,15,15) to (1, 1, 1). The brightness floor keeps
 * near-black out of the ratio maths entirely, where rounding noise would
 * otherwise let it normalise into anything.
 */
/**
 * Distance from `pixel` to `marker` in peak-normalised channel space, or
 * `null` for a pixel too dark to have a meaningful ratio. Normalising is
 * what survives a modal scrim, which composites `alpha*colour +
 * (1-alpha)*backdrop` over the tile - AFFINE, not a pure scale, so an exact
 * ratio match is too strict (CONFIRMED LIVE: the cyan marker under the
 * settings dialog's scrim reads rgb(22,173,173), a normalised r of 0.13
 * against cyan's 0). Callers compare distances between the two markers
 * rather than testing one in isolation; the markers sit at opposite corners
 * of this space (distance ~1.41), so the nearest one is unambiguous.
 */
function markerDistance(pixel, marker) {
  const peak = Math.max(pixel.r, pixel.g, pixel.b);
  if (peak < 60) return null;
  const markerPeak = Math.max(marker.r, marker.g, marker.b);
  return Math.hypot(
    ...["r", "g", "b"].map(
      (channel) => pixel[channel] / peak - marker[channel] / markerPeak,
    ),
  );
}

function matchesMarkerColor(pixel, marker) {
  const distance = markerDistance(pixel, marker);
  return distance !== null && distance <= MARKER_MATCH_DISTANCE;
}

function looksLikeMarker(pixel) {
  return [GUEST_COLOR_INITIAL, GUEST_COLOR_UPDATED].some((marker) =>
    matchesMarkerColor(pixel, marker),
  );
}

/**
 * Which of the three states a tile pixel is in, once the guest has been
 * flipped to a SECOND colour while the tile is occluded:
 *
 *   "frozen"  - the stand-in: the colour the guest had when the swap froze it
 *   "live"    - the native view itself, showing the guest's colour NOW
 *   "neither" - a gap: no stand-in and no painted native view
 *
 * Without that flip both surfaces are the same pixels and no capture at any
 * frame rate can tell them apart - the blind spot ticket 09's first run hit,
 * where even suppressing the stand-in entirely changed nothing on screen.
 */
function classifyTileSurface(pixel, frozen, live) {
  const toFrozen = markerDistance(pixel, frozen);
  const toLive = markerDistance(pixel, live);
  if (toFrozen === null || toLive === null) return "neither";
  const nearest = Math.min(toFrozen, toLive);
  if (nearest > MARKER_MATCH_DISTANCE) return "neither";
  return toFrozen <= toLive ? "frozen" : "live";
}

/**
 * A point WELL INSIDE `tileRect`, as far as possible from `avoidRect` (the
 * overlay) and never under it. Quadrant points, not the tile's own corners:
 * CONFIRMED LIVE that a 4px-inset corner is not tile content at all - the
 * window's rounded corners read back semi-transparent (alpha 99), and a
 * floating app widget sits over the tile's bottom-right (sampled a green
 * rgb(47,138,2) there) - so corner sampling reports the tile as blank when
 * it is painting fine.
 *
 * Returns `null` when every candidate is under the overlay: a tile that is
 * fully covered has no visible region to check for a gap, so the caller
 * skips rather than inventing a violation.
 */
function farCornerOfTile(tileRect, avoidRects) {
  const candidates = [0.25, 0.75].flatMap((fx) =>
    [0.25, 0.75].map((fy) => ({
      x: tileRect.x + tileRect.width * fx,
      y: tileRect.y + tileRect.height * fy,
    })),
  );
  const visible = candidates.filter((point) =>
    avoidRects.every(
      (avoidRect) =>
        point.x < avoidRect.x ||
        point.x > avoidRect.x + avoidRect.width ||
        point.y < avoidRect.y ||
        point.y > avoidRect.y + avoidRect.height,
    ),
  );
  if (visible.length === 0) return null;
  const last = avoidRects.at(-1) ?? {
    x: tileRect.x,
    y: tileRect.y,
    width: 0,
    height: 0,
  };
  const avoidCenter = {
    x: last.x + last.width / 2,
    y: last.y + last.height / 2,
  };
  return visible.reduce((best, point) => {
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return distance(point, avoidCenter) > distance(best, avoidCenter)
      ? point
      : best;
  });
}

/**
 * Drives one open/close pair over `tile`, sampling screenshots at high
 * cadence across both the hide edge (open) and the restore edge (close), and
 * classifying every frame for the two violations invariant 4 forbids.
 */
async function runOverlayEdgePair(client, tile, appWindow, dpr, guest, driver) {
  // No "before open" overlay-rect hint: nothing is open yet, so it would
  // only be `null` - `sampleEdge`'s own `??` fallback to a live query
  // (evaluated once `driver.open()` has resolved) already does the right
  // thing without it.
  const openViolations = await sampleEdge(
    client,
    tile,
    appWindow,
    dpr,
    driver.open,
    [],
  );

  // The tile is occluded now, so flip the LIVE guest to the other marker
  // colour: from here to the end of this edge pair the frozen stand-in and
  // the live native view are different pixels, and the compositor's output
  // says which one is actually on screen. This is the check that does NOT
  // depend on catching a sub-frame transient - it reads a steady state.
  const frozen = guest.color;
  const live =
    frozen === GUEST_COLOR_INITIAL ? GUEST_COLOR_UPDATED : GUEST_COLOR_INITIAL;
  await setGuestColor(guest.port, guest.rendererTargetId, live);
  guest.color = live;
  await delay(GUEST_FLIP_SETTLE_MS);
  const occludedViolations = await classifyOccludedSurfaces(
    client,
    tile,
    appWindow,
    dpr,
    frozen,
    live,
  );

  const beforeCloseOverlays = await evaluate(
    client,
    openOverlayRectsExpression(),
  );
  const closeViolations = await sampleEdge(
    client,
    tile,
    appWindow,
    dpr,
    driver.close,
    beforeCloseOverlays,
  );

  const restoreViolations = await classifyRestoredSurface(
    client,
    tile,
    appWindow,
    dpr,
    frozen,
    live,
  );

  return {
    open: [...openViolations, ...occludedViolations],
    close: [...closeViolations, ...restoreViolations],
  };
}

/**
 * While the overlay is open and the guest has been flipped: the tile must be
 * showing the FROZEN stand-in, and the overlay's own region must be showing
 * neither marker.
 */
async function classifyOccludedSurfaces(
  client,
  tile,
  appWindow,
  dpr,
  frozen,
  live,
) {
  const violations = [];
  const sample = await captureScreenshot(appWindow.windowId);
  const overlayRects = await evaluate(client, openOverlayRectsExpression());
  const topmost = await evaluate(client, openOverlayRectExpression());

  const point = farCornerOfTile(tile.rect, overlayRects);
  if (point !== null) {
    const pixel = await samplePixel(
      client,
      sample.base64,
      point.x,
      point.y,
      dpr,
    );
    const surface = classifyTileSurface(pixel, frozen, live);
    if (surface === "live") {
      // The guest repainted a new colour and the TILE followed it - so the
      // native view never left the screen for this overlay. That is the
      // paint-ack/park handshake not doing its job, and it is exactly what
      // a same-colour marker can never show.
      violations.push({
        kind: "native-visible-while-occluded",
        timestamp: sample.timestamp,
        pixel,
      });
    } else if (surface === "neither") {
      violations.push({
        kind: "stand-in-gap",
        timestamp: sample.timestamp,
        pixel,
      });
    }
  }

  if (topmost !== null && topmost.opacity >= 0.99) {
    const center = {
      x: topmost.x + topmost.width / 2,
      y: topmost.y + topmost.height / 2,
    };
    const pixel = await samplePixel(
      client,
      sample.base64,
      center.x,
      center.y,
      dpr,
    );
    if (classifyTileSurface(pixel, frozen, live) !== "neither") {
      violations.push({
        kind: "native-above-overlay",
        timestamp: sample.timestamp,
        pixel,
      });
    }
  }
  return violations;
}

/**
 * Once the restore edge has settled the tile must be showing the LIVE view
 * again - the colour the guest changed to while it was occluded. Still the
 * frozen colour means a stand-in that was never dropped; neither is a hole.
 */
async function classifyRestoredSurface(
  client,
  tile,
  appWindow,
  dpr,
  frozen,
  live,
) {
  await delay(GUEST_FLIP_SETTLE_MS);
  const sample = await captureScreenshot(appWindow.windowId);
  const overlayRects = await evaluate(client, openOverlayRectsExpression());
  const point = farCornerOfTile(tile.rect, overlayRects);
  if (point === null) return [];
  const pixel = await samplePixel(client, sample.base64, point.x, point.y, dpr);
  const surface = classifyTileSurface(pixel, frozen, live);
  if (surface === "frozen") {
    return [
      {
        kind: "stale-stand-in-after-restore",
        timestamp: sample.timestamp,
        pixel,
      },
    ];
  }
  if (surface === "neither") {
    return [{ kind: "stand-in-gap", timestamp: sample.timestamp, pixel }];
  }
  return [];
}

/**
 * Runs `action` (an open or a close), sampling OS-level window screenshots
 * (the real compositor output - see the header note on why CDP screenshots
 * cannot be used here) at `EDGE_SAMPLE_INTERVAL_MS` cadence for
 * `EDGE_SAMPLE_WINDOW_MS` starting just before `action` and continuing
 * after it settles, so the swap edge itself (not just before/after steady
 * states) is covered. Each `screencapture` call costs real wall-clock time
 * (spawning a process, encoding a PNG), so the achieved cadence is whatever
 * that costs plus `EDGE_SAMPLE_INTERVAL_MS` - fewer, not missing, samples
 * across the window.
 */
async function sampleEdge(
  client,
  tile,
  appWindow,
  dpr,
  action,
  overlayRectsHint,
) {
  const violations = [];
  const samples = [];
  const actionPromise = action();
  const deadline = performance.now() + EDGE_SAMPLE_WINDOW_MS;
  while (performance.now() < deadline) {
    const screenshot = await captureScreenshot(appWindow.windowId);
    // The overlay rect is read PER SAMPLE, right after its capture, not once
    // after the whole window: an open edge's first frames are taken before
    // Radix has mounted the portal at all, and classifying those against the
    // rect the menu ends up at reports the native view - legitimately still
    // on screen, with nothing over it yet - as "native-above-overlay"
    // (CONFIRMED LIVE: the menu first appears ~300ms after the click, and
    // the frames before it flagged every run). Same on the close edge, where
    // the overlay is gone for the later frames.
    screenshot.overlayRect = await evaluate(
      client,
      openOverlayRectExpression(),
    );
    screenshot.overlayRects = await evaluate(
      client,
      openOverlayRectsExpression(),
    );
    samples.push(screenshot);
    await delay(EDGE_SAMPLE_INTERVAL_MS);
  }
  await actionPromise;

  for (const sample of samples) {
    // The hint only fills in for a sample taken when nothing was open: it
    // carries the rects this edge is ABOUT, so a close edge's post-close
    // frames still avoid the region the overlay occupied.
    const overlayRect = sample.overlayRect;
    // Only a sample whose OWN capture had a fully-painted overlay on screen
    // can show one being painted over - the hint-filled rect is for the gap
    // check's avoid-region below, never for this one.
    if (sample.overlayRect !== null && sample.overlayRect.opacity >= 0.99) {
      const overlayCenter = {
        x: overlayRect.x + overlayRect.width / 2,
        y: overlayRect.y + overlayRect.height / 2,
      };
      const overlayPixel = await samplePixel(
        client,
        sample.base64,
        overlayCenter.x,
        overlayCenter.y,
        dpr,
      );
      if (
        colorsClose(overlayPixel, GUEST_COLOR_INITIAL) ||
        colorsClose(overlayPixel, GUEST_COLOR_UPDATED)
      ) {
        violations.push({
          kind: "native-above-overlay",
          timestamp: sample.timestamp,
          pixel: overlayPixel,
        });
      }
    }

    const farCorner = farCornerOfTile(
      tile.rect,
      sample.overlayRects.length > 0 ? sample.overlayRects : overlayRectsHint,
    );
    if (farCorner === null) continue;
    const tilePixel = await samplePixel(
      client,
      sample.base64,
      farCorner.x,
      farCorner.y,
      dpr,
    );
    // No background-color reference to compare against: the sampled point is
    // a VISIBLE part of the tile (`farCornerOfTile` already excluded points
    // under the overlay), so it must be showing the guest marker - live
    // view or stand-in, both are the same pixels. Anything else IS the gap,
    // whatever colour it happens to be. (The previous reference pixel, the
    // window's own top-left at 4,4, is not app chrome at all: it is inside
    // the rounded window corner and reads back fully transparent.)
    if (!looksLikeMarker(tilePixel)) {
      violations.push({
        kind: "stand-in-gap",
        timestamp: sample.timestamp,
        pixel: tilePixel,
      });
    }
  }
  return violations;
}

function assertNoEdgeViolation(label, edge) {
  assert.deepEqual(
    edge.open,
    [],
    `${label} hide edge showed a violation:\n${JSON.stringify(edge.open, null, 2)}`,
  );
  assert.deepEqual(
    edge.close,
    [],
    `${label} restore edge showed a violation:\n${JSON.stringify(edge.close, null, 2)}`,
  );
  console.log(
    `[probe] ${label}: no native-above-overlay or stand-in-gap frame`,
  );
}

// ---------------------------------------------------------------------------
// Freshness (invariant 6 / electron#6426): the stand-in must reflect the
// guest's CURRENT content, not a stale cached frame.
// ---------------------------------------------------------------------------

/**
 * Unlike EDGE sampling, FRESHNESS reads the RENDERER target directly rather
 * than an OS-level capture: the stand-in `<img>` is a genuine renderer DOM
 * element (its `src` is main's `capturePage()` data URL), so CDP sees it
 * fine - this decodes that element's own bitmap in place, instead of
 * screenshotting the whole window and re-locating it there.
 */
/**
 * Repaints the guest's marker page to `color` in place (no navigation, so
 * the tile is never torn down) - the same mechanism FRESHNESS uses, hoisted
 * so the EDGE checks can flip the live view out from under a frozen
 * stand-in and tell the two apart.
 */
async function setGuestColor(port, rendererTargetId, color) {
  const guestTarget = await resolveGuestTarget(port, rendererTargetId);
  const guestClient = await connectCdp(guestTarget.webSocketDebuggerUrl);
  try {
    await guestClient.send("Runtime.enable");
    const hex = rgbToHex(color);
    await guestClient.send("Runtime.evaluate", {
      expression: `document.body.style.background = "${hex}"; document.getElementById("marker") && (document.getElementById("marker").style.background = "${hex}");`,
      awaitPromise: false,
    });
  } finally {
    guestClient.close();
  }
}

async function assertStandInFreshness(client, guest) {
  const port = guest.port;
  const rendererTargetId = guest.rendererTargetId;
  // Flip to whichever colour the guest is NOT currently showing. Hardcoding
  // the "updated" colour here would be vacuous now that the EDGE cycles
  // above leave the guest on either one - the check would assert the
  // stand-in shows a colour it already had.
  const next =
    guest.color === GUEST_COLOR_INITIAL
      ? GUEST_COLOR_UPDATED
      : GUEST_COLOR_INITIAL;
  const guestTarget = await resolveGuestTarget(port, rendererTargetId);
  const guestClient = await connectCdp(guestTarget.webSocketDebuggerUrl);
  await guestClient.send("Runtime.enable");
  try {
    const hex = rgbToHex(next);
    guest.color = next;
    await guestClient.send("Runtime.evaluate", {
      expression: `document.body.style.background = "${hex}"; document.getElementById("marker") && (document.getElementById("marker").style.background = "${hex}");`,
      awaitPromise: false,
    });
    // Occlude immediately after the flip - the whole point is testing
    // whether the capture beats a stale cache, not giving it time to catch up.
    await openDropdown(client);
    await waitFor(
      client,
      "the stand-in <img> to appear",
      `document.querySelector('[data-browser-view-snapshot] img') !== null`,
    );
    const pixel = await evaluate(
      client,
      `(async () => {
        const img = document.querySelector('[data-browser-view-snapshot] img');
        if (!(img instanceof HTMLImageElement)) return null;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(
          Math.floor(img.naturalWidth / 2),
          Math.floor(img.naturalHeight / 2),
          1,
          1,
        ).data;
        return { r: data[0], g: data[1], b: data[2] };
      })()`,
    );
    assert.ok(
      pixel !== null && colorsClose(pixel, next),
      `Stand-in did not show the freshly-flipped guest content: sampled ${JSON.stringify(pixel)}, expected ~${JSON.stringify(next)} (electron#6426 - capturePage may be returning a stale frame)`,
    );
    console.log(
      "[probe] FRESHNESS: stand-in reflects the guest's latest paint",
    );
  } finally {
    await closeOverlayWithEscape(client);
    guestClient.close();
  }
}

/**
 * The tile's guest (the WebContentsView showing the marker `data:` page) is
 * its own CDP target, separate from the renderer target this script is
 * mainly attached to - Electron exposes every WebContentsView as its own
 * `/json/list` entry. Resolved by EXCLUSION - the one page target that is
 * neither the app renderer (`rendererTargetId`) nor a devtools frontend -
 * rather than matching on URL: the caller may need this target BEFORE it
 * has navigated anywhere in particular (`navigateTileToMarker` resolves it
 * first, then drives the navigation itself).
 */
async function resolveGuestTarget(port, rendererTargetId) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const response = await fetch(listUrl);
    if (response.ok) {
      const targets = await response.json();
      const candidates = targets.filter(
        (target) =>
          target.type === "page" &&
          target.id !== rendererTargetId &&
          !String(target.url).startsWith("devtools://"),
      );
      if (
        candidates.length === 1 &&
        typeof candidates[0].webSocketDebuggerUrl === "string"
      ) {
        return candidates[0];
      }
    }
    await delay(100);
  }
  throw new Error(
    `Could not resolve exactly one guest page target on port ${port} (excluding the app renderer and devtools) - is the tile's WebContentsView still open?`,
  );
}

/** Polls `/json/list` until `targetId`'s reported `url` matches `expectedUrl`. */
async function waitForTargetUrl(
  port,
  targetId,
  expectedUrl,
  timeoutMs = 15_000,
) {
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const response = await fetch(listUrl);
    if (response.ok) {
      const targets = await response.json();
      const match = targets.find((target) => target.id === targetId);
      if (match !== undefined && match.url === expectedUrl) return;
    }
    await delay(30);
  }
  throw new Error(
    `Timed out waiting for target ${targetId} on port ${port} to navigate to ${expectedUrl}`,
  );
}

// ---------------------------------------------------------------------------
// DPR (electron#8314): what resolution capturePage actually returns.
// ---------------------------------------------------------------------------

async function reportDpr(client) {
  await openDropdown(client);
  // The stand-in is not mounted the instant the menu opens - it costs a
  // full occlude round trip (see the click-to-standin constant below), so
  // reading it immediately reports "no stand-in was mounted" every time.
  try {
    await waitFor(
      client,
      "the stand-in <img> to mount before sampling its resolution",
      `document.querySelector('[data-browser-view-snapshot] img') !== null`,
      5_000,
    );
  } catch {
    // Fall through to the null-snapshot branch below, which already says so.
  }
  const snapshot = await evaluate(
    client,
    `(() => {
      const wrapper = document.querySelector('[data-browser-view-snapshot]');
      const img = wrapper?.querySelector('img') ?? null;
      const rect = wrapper?.getBoundingClientRect();
      if (img === null || rect === undefined) return null;
      return {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        cssWidth: rect.width,
        cssHeight: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      };
    })()`,
  );
  await closeOverlayWithEscape(client);
  if (snapshot === null) {
    console.log(
      "[probe] DPR: no stand-in <img> was mounted (snapshot may have raced the dropdown close) - re-run to sample",
    );
    return;
  }
  const expectedWidth = snapshot.cssWidth * snapshot.devicePixelRatio;
  const expectedHeight = snapshot.cssHeight * snapshot.devicePixelRatio;
  const observedRatioX = snapshot.naturalWidth / snapshot.cssWidth;
  const observedRatioY = snapshot.naturalHeight / snapshot.cssHeight;
  console.log(
    `[probe] DPR: capturePage returned ${snapshot.naturalWidth}x${snapshot.naturalHeight}px for a ${snapshot.cssWidth}x${snapshot.cssHeight}CSS-px tile at devicePixelRatio=${snapshot.devicePixelRatio} ` +
      `(expected ${expectedWidth}x${expectedHeight} at native res; observed ratio ${observedRatioX.toFixed(3)}x / ${observedRatioY.toFixed(3)}y)`,
  );
}

// ---------------------------------------------------------------------------
// Constants for the ADR (ticket 10): no pass/fail, numbers only.
// ---------------------------------------------------------------------------

async function reportClickToStandInLatency(client, sampleCount) {
  const latencies = [];
  for (let index = 0; index < sampleCount; index += 1) {
    // No manual `img.remove()` here: the stand-in `<img>` is React-owned
    // (`BrowserViewSnapshotLayer`), and `closeOverlayWithEscape` at the
    // bottom of the previous iteration already released the tile, which
    // unmounts the whole `[data-browser-view-snapshot]` wrapper - so the
    // `waitFor` below is already waiting for a FRESH mount, not a stale one.
    // Mutating a React-owned node out from under it would only fight the
    // reconciler.
    const requestedAt = await openDropdown(client);
    await waitFor(
      client,
      "the stand-in <img> to appear",
      `document.querySelector('[data-browser-view-snapshot] img') !== null`,
      5_000,
    );
    const settledAt = performance.now();
    latencies.push(settledAt - requestedAt);
    await closeOverlayWithEscape(client);
    await delay(50);
  }
  console.log(
    `[probe] CONSTANTS - click-to-standin-set latency (dropdown click -> stand-in <img> observed), n=${sampleCount}:`,
  );
  console.log(`         ${JSON.stringify(distribution(latencies))} ms`);
}

/**
 * The canvas that hosts a browser tile is a resizable split-pane tree, not a
 * scrolling container - a tile fills its pane edge-to-edge and there is no
 * scrollable ancestor above `[data-browser-view-surface]` to scroll (dev
 * exploration, 2026-09-02). Invariant 8 names pane resize as one of the two
 * genuine "motion" inputs (the other, canvas scroll/pane animation, has no
 * driveable hook in the current tree), so this drags the pane's own
 * `[data-testid="split-resize-handle"]` - a real user gesture that changes
 * the tile's rect every frame, exactly like the bounds-bridge rAF loop
 * (`use-browser-view-bounds-bridge.ts`) is measuring.
 */
async function reportMotionRest(client, sampleCount) {
  const firstHandlePoint = await elementCenter(
    client,
    '[data-testid="split-resize-handle"]',
  );
  if (firstHandlePoint === null) {
    console.log(
      '[probe] CONSTANTS - motion rest: no [data-testid="split-resize-handle"] found (tile is not in a split pane), skipping',
    );
    return;
  }
  const restDelays = [];
  for (let index = 0; index < sampleCount; index += 1) {
    // Re-resolved every iteration: the previous iteration's drag actually
    // moved the pane split, so the handle's own position drifts sample to
    // sample - a position captured once, before the loop, would go stale.
    const handlePoint = await elementCenter(
      client,
      '[data-testid="split-resize-handle"]',
    );
    if (handlePoint === null) {
      console.log(
        "[probe] CONSTANTS - motion rest: split-resize-handle disappeared mid-run, stopping early",
      );
      break;
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: handlePoint.x,
      y: handlePoint.y,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: handlePoint.x,
      y: handlePoint.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    // Ends back at dx=0: every sample's drag is a round trip, not a net
    // shift, so the layout does not drift across `sampleCount` iterations.
    for (const dx of [8, 16, 24, 16, 8, 0]) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: handlePoint.x + dx,
        y: handlePoint.y,
        button: "left",
        buttons: 1,
      });
      await delay(16);
    }
    const scrollStoppedAt = performance.now();
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: handlePoint.x,
      y: handlePoint.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await waitFor(
      client,
      "the tile to un-park after motion (stand-in cleared)",
      `document.querySelector('[data-browser-view-snapshot] img') === null`,
      5_000,
    );
    restDelays.push(performance.now() - scrollStoppedAt);
    await delay(100);
  }
  console.log(
    `[probe] CONSTANTS - motion rest (drag-stop -> tile un-parked), n=${restDelays.length}:`,
  );
  console.log(`         ${JSON.stringify(distribution(restDelays))} ms`);
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
  };
}
