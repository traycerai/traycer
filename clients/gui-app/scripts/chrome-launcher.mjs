// The shared headless-Chrome launcher for the browser regression drivers:
// all four CI-gated scripts (see `run-tests.ts`) plus `toast-over-modal-
// hittest.mjs`. The two manual instruments (`window-host-modal-alignment-
// browser.mjs`, `host-boot-family-gallery-browser.mjs`) still carry their own
// standalone launchers.
//
// Each driver used to carry its own copy of "find Chrome, spawn it, wait for
// DevTools", and the copies drifted: only one of them honoured `CHROME_BIN`,
// only one retried a cold start, and the rest killed the browser PID alone
// and left its renderers and crashpad handlers behind. The hardening below
// was written for `diff-edit-browser-regression.mjs` (OSS #1552) after a CI
// runner had to reap exactly that orphan pile; it lives here so a fix lands
// once instead of five times.
//
// Consumers own everything downstream of the DevTools endpoint (CDP client,
// fixtures, assertions) - this module owns only the process.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Resolves a Chrome/Chromium executable, preferring `CHROME_BIN`.
 *
 * `purpose` names the caller in the failure message, which is the only thing
 * that differs between drivers.
 */
export async function findChrome(purpose) {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next platform-standard location.
    }
  }
  throw new Error(
    `Chrome is required for ${purpose}. Set CHROME_BIN to its executable.`,
  );
}

/**
 * Launches headless Chrome and waits for its DevTools endpoint, retrying the
 * whole spawn on timeout.
 *
 * A cold CI runner has been observed to take Chrome past the 30s DevTools
 * deadline outright (its FIRST stderr line arrived 21s after spawn), and a
 * single flat deadline makes that a hard failure. A retry only helps when it
 * starts clean, so each attempt gets a fresh profile directory, and a
 * timed-out attempt's whole process GROUP is terminated and verified gone
 * (see `terminateProcessTree`) and its profile removed before the next
 * spawn - otherwise the retry inherits a locked profile plus the previous
 * attempt's crashpad children, which is exactly the orphan pile the runner
 * had to reap. `detached: true` is what makes that possible: it puts Chrome
 * at the head of its own process group, so renderers and crashpad handlers
 * are addressable together as one negative-PGID signal instead of only the
 * browser PID.
 *
 * The debugging port is `0` and the real endpoint is read back off Chrome's
 * stderr: a port picked in advance is only free until Chrome gets round to
 * binding it, and on a retry it is still held by the attempt that just died.
 *
 * `profilePrefix` is the `mkdtemp` prefix for this driver's profile
 * directories, so a stray temp dir names the driver that leaked it.
 */
export async function launchChromeWithDevTools(chromePath, profilePrefix) {
  const chromeEnv = { ...process.env };
  delete chromeEnv.DBUS_SESSION_BUS_ADDRESS;
  const attempts = 3;
  let lastError = new Error("Chrome launch was not attempted");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const profilePath = await mkdtemp(path.join(tmpdir(), profilePrefix));
    const chrome = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-features=Translate",
        "--disable-sync",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${profilePath}`,
        "about:blank",
      ],
      { env: chromeEnv, stdio: ["ignore", "ignore", "pipe"], detached: true },
    );
    let chromeError = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk) => {
      chromeError += chunk;
    });
    // A spawn failure (ENOENT/EACCES) surfaces as an "error" event, not an
    // exit; without a listener Node throws it as an uncaught event before
    // the retry catch can clean up the attempt's profile.
    let spawnFailure = null;
    chrome.on("error", (error) => {
      spawnFailure = error instanceof Error ? error : new Error(String(error));
    });
    try {
      const devtoolsWebSocketUrl = await waitForDevToolsUrl(
        chrome,
        () => chromeError,
        () => spawnFailure,
      );
      const devtoolsHttpUrl = new URL(devtoolsWebSocketUrl);
      devtoolsHttpUrl.protocol = "http:";
      devtoolsHttpUrl.pathname = "";
      devtoolsHttpUrl.search = "";
      devtoolsHttpUrl.hash = "";
      return {
        chrome,
        profilePath,
        devtoolsWebSocketUrl,
        devtoolsHttpUrl,
        readError: () => chromeError,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `Chrome launch attempt ${attempt}/${attempts} failed: ${lastError.message}`,
      );
      await terminateProcessTree(chrome);
      await rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  throw lastError;
}

/**
 * Terminates a detached child's whole process TREE, with a bounded wait.
 *
 * The child is spawned `detached`, so it leads its own process group and its
 * descendants (Chrome's renderers and crashpad handlers, which survive a
 * plain parent kill - the CI runner had to reap exactly that pile) are all
 * addressable as one negative-PGID signal. SIGTERM first (Chrome ignores it
 * during early startup), a 2s grace, then SIGKILL to the group, then a
 * BOUNDED verification that no group member remains. A tree that somehow
 * survives SIGKILL fails loudly rather than letting a retry - or the final
 * cleanup - proceed over a half-dead tree.
 */
export async function terminateProcessTree(child) {
  const groupId = child.pid;
  if (groupId === undefined) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-groupId, signal);
      return true;
    } catch {
      // ESRCH: every member of the group is already gone.
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  const termDeadline = Date.now() + 2_000;
  while (signalGroup(0) && Date.now() < termDeadline) {
    await delay(50);
  }
  if (!signalGroup("SIGKILL")) return;
  const killDeadline = Date.now() + 2_000;
  while (signalGroup(0) && Date.now() < killDeadline) {
    await delay(50);
  }
  if (signalGroup(0)) {
    throw new Error(
      `Chrome process group ${groupId} survived SIGKILL; refusing to continue over a half-dead tree`,
    );
  }
}

async function waitForDevToolsUrl(child, readError, readSpawnFailure) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const spawnFailure = readSpawnFailure();
    if (spawnFailure !== null) {
      throw new Error(`Chrome failed to spawn: ${spawnFailure.message}`);
    }
    // A signal-terminated Chrome (an OOM-killed cold start is the CI case)
    // leaves exitCode null and sets signalCode; without checking both, the
    // wait would burn its whole deadline on a corpse instead of retrying.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Chrome exited before DevTools was ready:\n${readError()}`,
      );
    }
    const match = readError().match(
      /DevTools listening on (ws:\/\/[^\s]+\/devtools\/browser\/[^\s]+)/,
    );
    if (match !== null) return match[1];
    await delay(50);
  }
  throw new Error(`Timed out waiting for Chrome DevTools:\n${readError()}`);
}
