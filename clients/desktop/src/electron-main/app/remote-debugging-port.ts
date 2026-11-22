import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../config";
import { log } from "./logger";

// The off switch for one machine. There is no screen behind it: the port has
// no password and every account on a shared machine can reach it, so a person
// who does not want it writes `{ "remoteDebuggingPortEnabled": false }` here.
const PREFERENCE_FILE_NAME = "remote-debugging-port.json";

/**
 * Staging builds open a DevTools port on every start so an agent
 * investigating a reported bug can see the running app as the user sees it,
 * without the user relaunching it with a flag. Production, and any
 * environment this file does not know, never opens one.
 */
function debuggingPortAllowed(environment: Environment): boolean {
  return environment === "staging";
}

function turnedOffOnThisMachine(): boolean {
  let preference: unknown;
  try {
    preference = JSON.parse(
      readFileSync(join(app.getPath("userData"), PREFERENCE_FILE_NAME), "utf8"),
    );
  } catch (err) {
    // No file is the usual case. Nothing in the app writes this file, so one
    // that is there but unreadable was written by a person turning the port
    // off, and a typo in it must not leave the port open.
    return !isFileMissing(err);
  }
  return (
    typeof preference === "object" &&
    preference !== null &&
    "remoteDebuggingPortEnabled" in preference &&
    preference.remoteDebuggingPortEnabled === false
  );
}

function isFileMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
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
  if (turnedOffOnThisMachine()) return;
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  log.info(
    "[debugging-port] requested a DevTools port; read it from DevToolsActivePort in the user-data folder",
  );
}
