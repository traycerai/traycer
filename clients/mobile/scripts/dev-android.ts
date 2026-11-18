/**
 * Android emulator launcher - the mirror of `dev-ios.ts`, consuming the same
 * slot and the same `run.json`. Slot resolution, metadata reading, and the
 * Capacitor live-reload handoff are shared in `dev-run.ts`.
 *
 * The one thing Android needs that iOS does not: the emulator is a separate
 * machine as far as sockets are concerned, so its `127.0.0.1` is its own
 * loopback, not the Mac's. `adb reverse` is what closes that gap - it maps
 * each dev port on the DEVICE's loopback back to the same port on this
 * machine, so every `http://localhost:<port>` the Vite config bakes in
 * (authn, cloud UI, the GUI App server) and the host's `ws://127.0.0.1:<port>`
 * RPC socket resolve unchanged, with no Android-only URL rewriting anywhere in
 * the app.
 *
 * `adb reverse` is preferred over the emulator's `10.0.2.2` host alias for
 * exactly that reason: the alias would force a second, Android-shaped set of
 * URLs through `vite.config.ts`, and it does not exist on a physical device.
 * (Debug builds still permit cleartext to `10.0.2.2` as a manual fallback -
 * see `android/app/src/debug/res/xml/network_security_config.xml`.)
 */
import { spawnSync } from "node:child_process";
import {
  ensureWebAssets,
  readDevRun,
  readFlag,
  readHostRpcPort,
  requireSlot,
  runCapacitorLiveReload,
  waitForGuiApp,
} from "./dev-run";

interface DevAndroidOptions {
  readonly slot: string;
  readonly target: string;
}

function adb(args: readonly string[]): string {
  const result = spawnSync("adb", [...args], { encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(
      "adb was not found on PATH; install the Android SDK platform-tools (ANDROID_HOME/platform-tools)",
    );
  }
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * The one attached device/emulator, or an explicit `--target`. Deliberately
 * strict about "exactly one", matching the Simulator side: a silent choice
 * between two emulators is the kind of thing that costs half an hour.
 */
function attachedDeviceSerial(): string {
  const serials = adb(["devices"])
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))
    .filter((columns) => columns.length >= 2 && columns[1] === "device")
    .map((columns) => columns[0]);
  if (serials.length !== 1) {
    throw new Error(
      "Attach exactly one Android emulator or device (adb devices), or pass --target/ANDROID_SERIAL",
    );
  }
  return serials[0];
}

function parseOptions(args: readonly string[]): DevAndroidOptions {
  if (args.includes("--help")) {
    console.log(
      "bun run dev:android -- --slot <slot> [--target <emulator-serial>]",
    );
    process.exit(0);
  }
  return {
    slot: requireSlot(args),
    target:
      readFlag(args, "--target") ??
      process.env.ANDROID_SERIAL ??
      attachedDeviceSerial(),
  };
}

/**
 * Must run after `waitForGuiApp`: that is what makes the host's live RPC port
 * readable (see `readHostRpcPort`). The RPC socket is the one the app exists to
 * talk to, so its absence is announced rather than left to be inferred from an
 * app that loads and then reaches nothing.
 */
function reverseDevPorts(
  target: string,
  slot: string,
  publishedPorts: readonly number[],
): void {
  const rpcPort = readHostRpcPort(slot);
  if (rpcPort === null) {
    console.warn(
      `[gui-app] WARNING: could not read the live host RPC port from the ${slot} pid.json. ` +
        "Any port recorded in run.json is still tunnelled, but it may be stale, in which case " +
        "the app will load and never reach a host. Restart make dev-gui-app, then re-run this script.",
    );
  }
  const ports = [
    ...new Set(
      rpcPort === null ? publishedPorts : [...publishedPorts, rpcPort],
    ),
  ].sort((left, right) => left - right);
  for (const port of ports) {
    adb(["-s", target, "reverse", `tcp:${port}`, `tcp:${port}`]);
  }
  console.log(`[gui-app] adb reverse: ${ports.join(", ")}`);
}

const options = parseOptions(process.argv.slice(2));
const { urls, ports } = readDevRun(options.slot);
await waitForGuiApp(urls.guiAppBaseUrl);
ensureWebAssets(options.slot, urls);
// After the GUI App answers (so the live RPC port is readable) but before
// Capacitor installs and launches: the app dials loopback on first paint, so
// the tunnels have to already exist. They are per-device state that survives
// this process, and re-running is how a restarted host gets picked up.
reverseDevPorts(options.target, options.slot, ports);
console.log(
  `[gui-app] slot=${options.slot} device=${options.target} url=${urls.guiAppBaseUrl.origin}`,
);
const exitCode = await runCapacitorLiveReload(
  "android",
  options.target,
  urls.guiAppBaseUrl,
);
if (exitCode !== 0) {
  process.exit(exitCode);
}
console.log(
  "[gui-app] Capacitor is connected to the shared live-reload server",
);
