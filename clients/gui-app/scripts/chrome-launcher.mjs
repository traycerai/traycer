// Shared headless-Chrome launcher for the CI-gated browser drivers. This module owns only the process; consumers own everything downstream of DevTools.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Resolve Chrome/Chromium, preferring CHROME_BIN. purpose names the caller in the failure message. */
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

/** Launch headless Chrome and wait for DevTools, retrying the whole spawn on timeout. Each attempt gets a fresh profile; terminate the timed-out process group first. Port is `0`; read the endpoint from stderr. */
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
 * Kill a detached child's process group: SIGTERM, 2s grace, SIGKILL, then fail if any member remains.
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
