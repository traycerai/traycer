import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Whether a Linux tray icon can actually be SEEN (host-lifecycle-modes,
// T08 CLOSE-LNX-NO-TRAY).
//
// `new Tray()` never throws on Linux for a missing tray host. Chromium
// registers a StatusNotifierItem, and with no StatusNotifierWatcher on the
// session bus it falls back to an XEmbed icon, which with no XEmbed tray
// manager is an unmapped window nothing docks. Stock GNOME (no AppIndicator
// extension) is exactly that, so "a Tray object exists" is not "a tray
// exists", and a close-to-tray there hid the app into nothing.
//
// The question is asked of the StatusNotifier watcher itself: a host (a
// panel that shows SNI icons) has registered with it. XEmbed-only tray
// managers (i3bar, awesome, stalonetray) deliberately read as NO tray -
// nothing in a base install reads an X selection owner - so a close there
// runs the quit policy. The accepted cost is one prompt; the alternative was
// stranding an invisible app.

const execFileAsync = promisify(execFile);

/** Each tool's bound. The close is waiting on this answer. */
export const LINUX_TRAY_HOST_PROBE_TIMEOUT_MS = 1_000;

const WATCHER_NAME = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const HOST_REGISTERED_PROPERTY = "IsStatusNotifierHostRegistered";

/** One bounded tool run: its stdout, or why it produced none. */
export type TrayProbeRun =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

export type TrayProbeRunner = (
  command: string,
  args: readonly string[],
) => Promise<TrayProbeRun>;

const runProbeTool: TrayProbeRunner = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      timeout: LINUX_TRAY_HOST_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return { kind: "ok", stdout };
  } catch (error) {
    // ENOENT is the one failure that says nothing about the watcher: the tool
    // is not installed, so the next tool may still answer.
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "failed" };
  }
};

/** `gdbus` prints a boolean property as `(<true>,)`. */
function gdbusSaysTrue(stdout: string): boolean {
  return stdout.trim() === "(<true>,)";
}

/** `dbus-send --print-reply=literal` prints `variant       boolean true`. */
function dbusSendSaysTrue(stdout: string): boolean {
  return /\bboolean\s+true\b/.test(stdout);
}

/**
 * `true` only when the session bus positively says a StatusNotifier host is
 * registered. `gdbus` first, `dbus-send` when `gdbus` is not installed; a
 * missing watcher, a timeout, an error or an unreadable answer is `false`.
 */
export async function probeLinuxTrayHost(
  run: TrayProbeRunner | null,
): Promise<boolean> {
  const runner = run ?? runProbeTool;
  const gdbus = await runner("gdbus", [
    "call",
    "--session",
    "--dest",
    WATCHER_NAME,
    "--object-path",
    WATCHER_PATH,
    "--method",
    "org.freedesktop.DBus.Properties.Get",
    WATCHER_NAME,
    HOST_REGISTERED_PROPERTY,
  ]);
  if (gdbus.kind === "ok") return gdbusSaysTrue(gdbus.stdout);
  if (gdbus.kind === "failed") return false;
  const dbusSend = await runner("dbus-send", [
    "--session",
    "--print-reply=literal",
    `--dest=${WATCHER_NAME}`,
    WATCHER_PATH,
    "org.freedesktop.DBus.Properties.Get",
    `string:${WATCHER_NAME}`,
    `string:${HOST_REGISTERED_PROPERTY}`,
  ]);
  return dbusSend.kind === "ok" && dbusSendSaysTrue(dbusSend.stdout);
}

/**
 * Close time's tray answer: no tray object is no tray anywhere; on Linux a
 * constructed tray still has to be SEEN (`probe`, asked only there); on
 * Windows and macOS a constructed tray is a visible one.
 */
export function trayVisibleAtClose(input: {
  readonly platform: NodeJS.Platform;
  readonly trayConstructed: boolean;
  readonly probe: () => Promise<boolean>;
}): Promise<boolean> {
  if (!input.trayConstructed) return Promise.resolve(false);
  return input.platform === "linux" ? input.probe() : Promise.resolve(true);
}
