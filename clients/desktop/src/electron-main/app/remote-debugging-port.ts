import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../config";
import { log } from "./logger";

// The opt-in for one machine. There is no screen behind it: the machine's
// owner, or an agent acting for them, writes
// `{ "remoteDebuggingPortEnabled": true }` here once. Off by default because
// the port has no password and reaches every page the app hosts. Opting in
// grants nothing new: the same account can already relaunch the app with
// `--remote-debugging-port`, and the user-data folder is owner-only, so other
// accounts cannot write this file.
const PREFERENCE_FILE_NAME = "remote-debugging-port.json";

/**
 * Only staging builds may open a DevTools port, so an agent investigating a
 * reported bug can see the running app as the user sees it, across relaunches
 * from the Dock. Production, and any environment this file does not know,
 * never opens one.
 */
function debuggingPortAllowed(environment: Environment): boolean {
  return environment === "staging";
}

function turnedOnOnThisMachine(): boolean {
  let preference: unknown;
  try {
    preference = JSON.parse(
      readFileSync(join(app.getPath("userData"), PREFERENCE_FILE_NAME), "utf8"),
    );
  } catch {
    // No file, or one that cannot be read or parsed: the port stays off.
    return false;
  }
  return (
    typeof preference === "object" &&
    preference !== null &&
    "remoteDebuggingPortEnabled" in preference &&
    preference.remoteDebuggingPortEnabled === true
  );
}

/**
 * Must run pre-`whenReady`: Chromium reads the switch when it starts its
 * DevTools server, and a switch appended after ready opens nothing. Port 0
 * lets the system pick a free port, which Chromium binds to 127.0.0.1 and
 * writes to `<userData>/DevToolsActivePort` for an agent to read. That file
 * outlives the app, so after a quit it names a closed port. No
 * `remote-allow-origins`, so a web page cannot attach.
 */
export function applyRemoteDebuggingPortPreference(
  environment: Environment,
): void {
  if (!debuggingPortAllowed(environment)) return;
  // A port or pipe given at launch (a dev run, a person debugging by hand) is
  // theirs to keep; a second switch would only fight it.
  if (
    app.commandLine.hasSwitch("remote-debugging-port") ||
    app.commandLine.hasSwitch("remote-debugging-pipe")
  ) {
    return;
  }
  if (!turnedOnOnThisMachine()) return;
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  log.info(
    "[debugging-port] requested a DevTools port; read it from DevToolsActivePort in the user-data folder",
  );
}
