import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import { sanitizeDevDesktopSlot } from "../shared/platform/dev-desktop-slot";
import { devRelayBaseUrlFromEnv } from "../shared/platform/dev-backend-urls";

// Dev-server endpoint that re-reads the host's pid.json on every request. The
// baked define config only captures the host port as of Vite startup; the dev
// host allocates a fresh port each stack restart and often comes up AFTER
// Vite has read the previous run's file, so the client must be able to ask
// for the current address at runtime.
//
// BROWSER-TESTING SCAFFOLDING: this exists only for driving the web entry
// against a local `make dev-desktop` host. The shipped mobile client reaches
// remote hosts through real host discovery and must not depend on this.
const DEV_HOST_PATH = "/__traycer/dev-host";
/** Mirrors the desktop's baked value (`clients/desktop/src/config.ts`). */
const RELAY_BASE_URL = "wss://relay.traycer.ai/attach";

/**
 * Deployed backend sets for shipped bundles, selected with
 * `TRAYCER_MOBILE_ENV=staging|production` (default: `dev`, the loopback
 * scaffolding below). The values mirror the desktop's `config.ts` and the
 * host's `set-deploy-target` targets — these three endpoints move together.
 * A shipped bundle bakes its environment as a literal, so a stray env var
 * cannot repoint an installed app; only the dev config reads `TRAYCER_DEV_*`
 * overrides.
 */
const SHIPPED_ENVIRONMENTS = {
  staging: {
    authnBaseUrl: "https://authn.dev.traycer.ai",
    cloudUiBaseUrl: "https://platform.dev.traycer.ai",
    relayBaseUrl: "wss://relay.dev.traycer.ai/attach",
  },
  production: {
    authnBaseUrl: "https://authn.traycer.ai",
    cloudUiBaseUrl: "https://platform.traycer.ai",
    relayBaseUrl: RELAY_BASE_URL,
  },
} as const;

/**
 * Per-lane sign-in return scheme. The iOS release workflow stamps the staging
 * app into a SEPARATE identity (bundle id `ai.traycer.app.ios.staging` + this
 * URL scheme) so both lanes install side by side and the browser's sign-in
 * return reopens the right app; the baked value and the stamped scheme move
 * together - change one, change both (release-mobile-ios.yaml, "Stamp staging
 * app identity"). A staging bundle built locally in Xcode keeps the
 * checked-in `traycer` scheme, so its sign-in return cannot come back - use
 * the dev loop for local work.
 */
const SHIPPED_RETURN_SCHEMES = {
  staging: "traycer-staging",
  production: "traycer",
} as const;

type MobileEnvironment = "dev" | keyof typeof SHIPPED_ENVIRONMENTS;

function resolveMobileEnvironment(): MobileEnvironment {
  const raw = process.env.TRAYCER_MOBILE_ENV;
  if (raw === undefined || raw.trim().length === 0 || raw === "dev") {
    return "dev";
  }
  if (raw === "staging" || raw === "production") {
    return raw;
  }
  throw new Error(
    `TRAYCER_MOBILE_ENV must be dev, staging or production (got "${raw}")`,
  );
}

function shippedConfig(
  environment: keyof typeof SHIPPED_ENVIRONMENTS,
): TraycerMobileBakedConfig {
  const backends = SHIPPED_ENVIRONMENTS[environment];
  return {
    environment,
    authnBaseUrl: backends.authnBaseUrl,
    signInUrl: new URL("/sign-in", backends.cloudUiBaseUrl).toString(),
    relayBaseUrl: backends.relayBaseUrl,
    // Authn shows this on the device-flow approval page as who is asking.
    hostLabel: "Traycer Mobile",
    returnScheme: SHIPPED_RETURN_SCHEMES[environment],
    // No loopback host to dial: the shipped client discovers hosts through
    // the registry (`remoteFetcher={null}` → gui-app's default fetcher).
    devHost: null,
  };
}

interface DevHostPid {
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
}

const mobileRoot = __dirname;
const clientsRoot = resolve(mobileRoot, "..");
const guiAppRoot = resolve(clientsRoot, "gui-app");
const sharedRoot = resolve(clientsRoot, "shared");
const protocolRoot = resolve(clientsRoot, "..", "protocol");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required for the GUI App dev server`);
  }
  return value.trim();
}

function parseHttpBaseUrl(name: string, raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.origin;
}

function devHostPidPath(slot: string): string {
  return join(homedir(), ".traycer", "host", "dev-runs", slot, "pid.json");
}

async function readDevHost(slot: string): Promise<DevHostPid> {
  const pidPath = devHostPidPath(slot);
  const deadline = Date.now() + 30_000;
  let raw: string | null = null;
  while (raw === null && Date.now() < deadline) {
    try {
      raw = readFileSync(pidPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  if (raw === null) {
    throw new Error(`Timed out waiting for host metadata at ${pidPath}`);
  }
  return parseDevHostPid(raw, pidPath);
}

function parseDevHostPid(raw: string, pidPath: string): DevHostPid {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Invalid host metadata at ${pidPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const hostId = record.hostId;
  const version = record.version;
  const websocketUrl = record.websocketUrl;
  if (
    typeof hostId !== "string" ||
    hostId.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    typeof websocketUrl !== "string" ||
    websocketUrl.length === 0
  ) {
    throw new Error(`Incomplete host metadata at ${pidPath}`);
  }
  const parsedWebsocketUrl = new URL(websocketUrl);
  if (
    parsedWebsocketUrl.protocol !== "ws:" &&
    parsedWebsocketUrl.protocol !== "wss:"
  ) {
    throw new Error(`Host metadata at ${pidPath} has a non-WebSocket URL`);
  }
  return { hostId, version, websocketUrl };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function devHostEndpoint(slot: string): Plugin {
  return {
    name: "traycer-dev-host-endpoint",
    configureServer(server) {
      server.middlewares.use(DEV_HOST_PATH, (_request, response) => {
        const pidPath = devHostPidPath(slot);
        let host: DevHostPid;
        try {
          host = parseDevHostPid(readFileSync(pidPath, "utf8"), pidPath);
        } catch {
          response.statusCode = 503;
          response.end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(host));
      });
    },
  };
}

async function guiAppDevConfig(): Promise<TraycerMobileBakedConfig> {
  const rawSlot = requiredEnv("DEV_DESKTOP_SLOT");
  const slot = sanitizeDevDesktopSlot(rawSlot);
  if (slot.length === 0) {
    throw new Error("DEV_DESKTOP_SLOT must contain a usable slot name");
  }
  const authnBaseUrl = parseHttpBaseUrl(
    "TRAYCER_DEV_AUTHN_BASE_URL",
    requiredEnv("TRAYCER_DEV_AUTHN_BASE_URL"),
  );
  const cloudUiBaseUrl = parseHttpBaseUrl(
    "TRAYCER_DEV_CLOUD_UI_BASE_URL",
    requiredEnv("TRAYCER_DEV_CLOUD_UI_BASE_URL"),
  );
  const host = await readDevHost(slot);
  return {
    environment: "dev",
    authnBaseUrl,
    signInUrl: new URL("/sign-in", cloudUiBaseUrl).toString(),
    // Same dev-gated posture as the desktop's `config.ts`: the shipped relay
    // endpoint unless this run exports its own (`make dev-remote` does). This
    // config only ever builds in dev, so the environment argument is fixed.
    relayBaseUrl: devRelayBaseUrlFromEnv(
      "dev",
      "TRAYCER_DEV_RELAY_BASE_URL",
      RELAY_BASE_URL,
      process.env,
    ),
    hostLabel: slot,
    // The checked-in scheme both native projects register; dev builds are
    // never re-stamped.
    returnScheme: "traycer",
    devHost: {
      devHostPath: DEV_HOST_PATH,
      host: {
        hostId: host.hostId,
        label: slot,
        // `local`, not `remote`: this entry IS a 127.0.0.1 host the browser
        // dials directly on its own `websocketUrl`, which is what `local` means
        // (`host-client/host-directory.ts`). `remote` now denotes the relay
        // path - an authn-minted attach grant plus a Noise-NK handshake against
        // the host's registry-published public key - and never dials this URL,
        // so a local address behind `remote` has no transport to build.
        kind: "local",
        websocketUrl: host.websocketUrl,
        version: host.version,
        status: "available",
      },
    },
  };
}

export default defineConfig(async (): Promise<UserConfig> => {
  const environment = resolveMobileEnvironment();
  const config =
    environment === "dev"
      ? await guiAppDevConfig()
      : shippedConfig(environment);

  // The dev server (and its pid.json endpoint) exist only for the loopback
  // scaffolding; a shipped build neither serves nor needs a port. The
  // physical-device lane (`dev:ios:device`) overrides the bind address so a
  // phone on the same LAN can load the bundle; everything else stays on
  // loopback.
  let server: UserConfig["server"];
  if (environment === "dev") {
    const portRaw = requiredEnv("PORT");
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("PORT must be a valid TCP port");
    }
    const hostRaw = process.env.TRAYCER_DEV_VITE_HOST;
    const host =
      typeof hostRaw === "string" && hostRaw.trim().length > 0
        ? hostRaw.trim()
        : "127.0.0.1";
    server = { host, port, strictPort: true };
  }

  return {
    root: resolve(mobileRoot, "src", "web"),
    define: {
      __TRAYCER_MOBILE_CONFIG__: JSON.stringify(config),
    },
    plugins: [
      ...(config.devHost === null
        ? []
        : [devHostEndpoint(config.devHost.host.label)]),
      tanstackRouter({
        enableRouteGeneration: false,
        target: "react",
        quoteStyle: "double",
        semicolons: true,
        autoCodeSplitting: true,
        routeFileIgnorePattern: "__tests__|route-components|route-search",
        routesDirectory: resolve(guiAppRoot, "src", "routes"),
        generatedRouteTree: resolve(guiAppRoot, "src", "routeTree.gen.ts"),
      }),
      react(),
      tailwindcss(),
      babel({ presets: [reactCompilerPreset()] }).then((plugin) => ({
        ...plugin,
        enforce: "post" as const,
      })),
    ],
    resolve: {
      alias: {
        "@traycer/protocol/utils": resolve(protocolRoot, "utils"),
        "@traycer/protocol": resolve(protocolRoot, "src"),
        "@traycer-clients/gui-app": guiAppRoot,
        "@traycer-clients/shared": sharedRoot,
        "@": resolve(guiAppRoot, "src"),
      },
    },
    build: {
      target: "es2022",
      emptyOutDir: true,
      outDir: resolve(mobileRoot, "dist", "web"),
      sourcemap: false,
    },
    server,
  };
});
