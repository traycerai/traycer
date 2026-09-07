/**
 * Physical-iPhone dev lane (`bun run dev:ios:device`, or `make dev-ios-device` from the internal repository).
 * The Simulator lane (`dev-ios.ts`) leans on the Simulator sharing the Mac's loopback; a real phone shares only the lan.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mobileRoot,
  readDevRun,
  readFlag,
  requireSlot,
  waitForGuiApp,
  type DevRunUrls,
} from "./dev-run";

const DEFAULT_DEVICE_VITE_PORT = 5814;

function detectLanIpv4(): string {
  for (const iface of ["en0", "en1"]) {
    try {
      const ip = execFileSync("ipconfig", ["getifaddr", iface], {
        encoding: "utf8",
      }).trim();
      if (ip.length > 0) return ip;
    } catch {
    // Interface without an address - try the next one.
    }
  }
  throw new Error(
    "Could not detect a LAN IPv4 (tried en0/en1); pass --lan-ip <address>",
  );
}

function withLanHost(rawUrl: string, lanIp: string): string {
  const url = new URL(rawUrl);
  url.hostname = lanIp;
  return url.origin;
}

function parsePort(raw: string | null): number {
  if (raw === null) return DEFAULT_DEVICE_VITE_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  return port;
}

function deviceLaneEnv(
  slot: string,
  lanUrls: DevRunUrls,
  lanIp: string,
  port: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEV_DESKTOP_SLOT: slot,
    PORT: String(port),
    TRAYCER_DEV_VITE_HOST: lanIp,
    TRAYCER_DEV_AUTHN_BASE_URL: lanUrls.authnBaseUrl,
    TRAYCER_DEV_CLOUD_UI_BASE_URL: lanUrls.cloudUiBaseUrl,
    TRAYCER_DEV_ALLOW_LAN_BACKEND: "1",
  };
}

function buildLanWebAssets(env: NodeJS.ProcessEnv): void {
  console.log("[device] building web assets against the LAN addresses");
  const build = spawnSync("bun", ["run", "build:web"], {
    cwd: mobileRoot,
    env,
    stdio: "inherit",
  });
  if (build.error !== undefined) throw build.error;
  if (build.status !== 0) {
    throw new Error(`web build failed with exit ${build.status}`);
  }
}

const args = process.argv.slice(2);
const slot = requireSlot(args);
const lanIp = readFlag(args, "--lan-ip") ?? detectLanIpv4();
const port = parsePort(readFlag(args, "--port"));
const target = readFlag(args, "--target");

const run = readDevRun(slot);
const lanUrls: DevRunUrls = {
  authnBaseUrl: withLanHost(run.urls.authnBaseUrl, lanIp),
  cloudUiBaseUrl: withLanHost(run.urls.cloudUiBaseUrl, lanIp),
  guiAppBaseUrl: new URL(`http://${lanIp}:${port}/`),
};
const env = deviceLaneEnv(slot, lanUrls, lanIp, port);

// Any HTTP status counts as alive; only a transport failure means "not running".
const authnAlive = await fetch(lanUrls.authnBaseUrl, {
  signal: AbortSignal.timeout(3_000),
}).then(
  () => true,
  () => false,
);
if (!authnAlive) {
  throw new Error(
    `authn is not answering at ${lanUrls.authnBaseUrl} — the ${slot} backend stack is not running (start \`make dev-gui-app\` in the internal repository first)`,
  );
}

buildLanWebAssets(env);

console.log(`[device] slot=${slot}`);
console.log(`[device] vite:   ${lanUrls.guiAppBaseUrl.origin}`);
console.log(`[device] authn:  ${lanUrls.authnBaseUrl}`);
console.log(`[device] cloud:  ${lanUrls.cloudUiBaseUrl}`);
// `dist/web` is left holding this run's lan http URLs.
// A release build made from the same checkout without re-running `build:web` would ship them, and on a device ats blocks every one - a shipped app that simply cannot reach its backend.
console.warn(
  "[device] dist/web now contains LAN http URLs — run `bun run build:web` before any release build from this checkout",
);

const vite = spawn("bun", ["x", "vite", "--config", "vite.config.ts"], {
  cwd: mobileRoot,
  env,
  stdio: "inherit",
});
vite.once("error", (error: Error) => {
  // `spawn` reports an unspawnable binary here, not by throwing: without a listener Node raises it as an uncaught exception and the lane dies with a stack trace instead of the one line that says what to install.
  console.error(`[device] could not start vite: ${error.message}`);
  process.exit(1);
});
vite.once("exit", (code) => {
  // The phone loads everything from this server; without it the lane is over.
  process.exit(code ?? 1);
});
const stopVite = () => {
  vite.kill("SIGINT");
};
process.once("SIGINT", stopVite);
process.once("SIGTERM", stopVite);

await waitForGuiApp(lanUrls.guiAppBaseUrl);

const capacitorArgs = [
  "x",
  "cap",
  "run",
  "ios",
  ...(target === null ? [] : ["--target", target]),
  "--live-reload",
  "--host",
  lanIp,
  "--port",
  String(port),
];
// Without --target Capacitor lists simulators and cable-connected devices and prompts; pick the physical phone there, or pass --target <udid> (find it via `xcrun xctrace list devices`).
const capacitor = spawn("bun", capacitorArgs, {
  cwd: mobileRoot,
  env,
  stdio: "inherit",
});
const capExit = await new Promise<number>((resolveExit, rejectExit) => {
  capacitor.once("error", rejectExit);
  capacitor.once("exit", (code) => resolveExit(code ?? 1));
});
if (capExit !== 0) {
  stopVite();
  process.exit(capExit);
}

console.log(
  "[device] app installed and pointed at this server; leave this running.",
);
console.log(
  "[device] loop: desktop Settings → Link mobile app → scan (or type the code) in the app.",
);
// Keep serving until Ctrl-C: the installed app loads from this Vite server on
// every launch.
await new Promise(() => undefined);
