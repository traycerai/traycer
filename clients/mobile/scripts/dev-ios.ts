/**
 * iOS Simulator launcher. Slot resolution, `run.json` reading, and the
 * Capacitor live-reload handoff live in `dev-run.ts`, shared with the Android
 * loop; what is left here is Simulator targeting.
 *
 * The Simulator shares the Mac's loopback interface, so the baked
 * `http://127.0.0.1:<port>` dev config resolves as-is with no tunnelling.
 */
import { spawnSync } from "node:child_process";
import {
  ensureWebAssets,
  readDevRun,
  readFlag,
  requireSlot,
  runCapacitorLiveReload,
  waitForGuiApp,
} from "./dev-run";

interface DevIosOptions {
  readonly slot: string;
  readonly target: string;
}

function bootedSimulatorId(): string {
  const result = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "booted", "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Could not read booted Simulator devices");
  }
  const devices = (parsed as Record<string, unknown>).devices;
  if (devices === null || typeof devices !== "object") {
    throw new Error("Could not read booted Simulator devices");
  }
  const ids = Object.values(devices)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter(
      (value): value is Record<string, unknown> =>
        value !== null && typeof value === "object",
    )
    .filter((value) => value.state === "Booted")
    .map((value) => value.udid)
    .filter((value): value is string => typeof value === "string");
  if (ids.length !== 1) {
    throw new Error(
      "Boot exactly one iOS Simulator or pass --target/IOS_SIMULATOR_UDID",
    );
  }
  return ids[0];
}

function parseOptions(args: readonly string[]): DevIosOptions {
  if (args.includes("--help")) {
    console.log("bun run dev:ios -- --slot <slot> [--target <simulator-udid>]");
    process.exit(0);
  }
  return {
    slot: requireSlot(args),
    target:
      readFlag(args, "--target") ??
      process.env.IOS_SIMULATOR_UDID ??
      bootedSimulatorId(),
  };
}

const options = parseOptions(process.argv.slice(2));
const { urls } = readDevRun(options.slot);
await waitForGuiApp(urls.guiAppBaseUrl);
ensureWebAssets(options.slot, urls);
console.log(
  `[gui-app] slot=${options.slot} simulator=${options.target} url=${urls.guiAppBaseUrl.origin}`,
);
const exitCode = await runCapacitorLiveReload(
  "ios",
  options.target,
  urls.guiAppBaseUrl,
);
if (exitCode !== 0) {
  process.exit(exitCode);
}
console.log(
  "[gui-app] Capacitor is connected to the shared live-reload server",
);
