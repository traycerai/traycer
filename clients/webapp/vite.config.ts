import { resolve } from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { devRelayBaseUrlFromEnv } from "../shared/platform/dev-backend-urls";

/**
 * The single path this bundle is served under, without a trailing slash.
 *
 * It is BOTH halves of one fact and they must not drift: Vite's `base` decides
 * how asset URLs are written into the built HTML, and the router's `basepath`
 * decides how the URL bar is parsed back into a route. A mismatch is silent in
 * a smoke test of `/app/` and breaks the moment a nested route is reloaded -
 * the server returns the same index.html and one of the two layers resolves it
 * against the wrong prefix.
 *
 * `base` must be absolute (`/app/`) rather than relative (`./`, what the
 * desktop renderer uses for `app://` / `file://`): the same index.html answers
 * `/app/epics/:id`, where a relative `./assets/x.js` would resolve against
 * `/app/epics/` and 404.
 */
const APP_BASE_PATH = "/app";

/** Mirrors the desktop's baked value (`clients/desktop/src/config.ts`). */
const RELAY_BASE_URL = "wss://relay.traycer.ai/attach";

/**
 * Deployed backend sets for shipped bundles, selected with
 * `TRAYCER_WEBAPP_ENV=staging|production` (default: `dev`, the loopback
 * scaffolding below). The values mirror the desktop's `config.ts` and the
 * host's `set-deploy-target` targets - these three endpoints move together.
 * A shipped bundle bakes its environment as a literal, so a stray env var
 * cannot repoint a deployed tab; only the dev config reads `TRAYCER_DEV_*`
 * overrides.
 *
 * `cloudUiBaseUrl` is also the ORIGIN this bundle has to be served from.
 * authn's CORS allow-list is the web dashboard origin
 * (`authn-v3` `corsOrigins`), and this shell owns its auth HTTP in-process
 * with no privileged process to escape through - so a tab served from any
 * other origin is refused at the device-authorize call, not at some later
 * edge case.
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

type WebappEnvironment = "dev" | keyof typeof SHIPPED_ENVIRONMENTS;

function resolveWebappEnvironment(): WebappEnvironment {
  const raw = process.env.TRAYCER_WEBAPP_ENV;
  if (raw === undefined || raw.trim().length === 0 || raw === "dev") {
    return "dev";
  }
  if (raw === "staging" || raw === "production") {
    return raw;
  }
  throw new Error(
    `TRAYCER_WEBAPP_ENV must be dev, staging or production (got "${raw}")`,
  );
}

function shippedConfig(
  environment: keyof typeof SHIPPED_ENVIRONMENTS,
): TraycerWebappBakedConfig {
  const backends = SHIPPED_ENVIRONMENTS[environment];
  return {
    environment,
    authnBaseUrl: backends.authnBaseUrl,
    signInUrl: new URL("/sign-in", backends.cloudUiBaseUrl).toString(),
    relayBaseUrl: backends.relayBaseUrl,
    // Authn shows this on the device-flow approval page as who is asking.
    hostLabel: "Traycer Web",
    basePath: APP_BASE_PATH,
  };
}

const webappRoot = __dirname;
const clientsRoot = resolve(webappRoot, "..");
const guiAppRoot = resolve(clientsRoot, "gui-app");
const sharedRoot = resolve(clientsRoot, "shared");
const protocolRoot = resolve(clientsRoot, "..", "protocol");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required for the web shell dev server`);
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

/**
 * The loopback dev bundle. Its authn is taken from the environment rather than
 * baked, because a dev server's own origin is not on any deployed authn's CORS
 * allow-list: only an authn this run controls
 * (`AUTHN_CORS_ALLOWED_ORIGINS`, which the local dev stack sets) will answer a
 * loopback tab. Pointing `TRAYCER_DEV_AUTHN_BASE_URL` at a deployed authn is
 * therefore a supported way to read deployed data ONLY if that authn admits
 * this origin; it is not a way to bypass the allow-list.
 */
function devConfig(): TraycerWebappBakedConfig {
  const authnBaseUrl = parseHttpBaseUrl(
    "TRAYCER_DEV_AUTHN_BASE_URL",
    requiredEnv("TRAYCER_DEV_AUTHN_BASE_URL"),
  );
  const cloudUiBaseUrl = parseHttpBaseUrl(
    "TRAYCER_DEV_CLOUD_UI_BASE_URL",
    requiredEnv("TRAYCER_DEV_CLOUD_UI_BASE_URL"),
  );
  return {
    environment: "dev",
    authnBaseUrl,
    signInUrl: new URL("/sign-in", cloudUiBaseUrl).toString(),
    // Same dev-gated posture as the desktop's `config.ts`: the shipped relay
    // endpoint unless this run exports its own. This branch only ever builds
    // in dev, so the environment argument is fixed.
    relayBaseUrl: devRelayBaseUrlFromEnv(
      "dev",
      "TRAYCER_DEV_RELAY_BASE_URL",
      RELAY_BASE_URL,
      process.env,
    ),
    hostLabel: "Traycer Web (dev)",
    basePath: APP_BASE_PATH,
  };
}

export default defineConfig((): UserConfig => {
  const environment = resolveWebappEnvironment();
  const config =
    environment === "dev" ? devConfig() : shippedConfig(environment);

  // The dev server exists only for the loopback loop; a shipped build neither
  // serves nor needs a port.
  let server: UserConfig["server"];
  if (environment === "dev") {
    const portRaw = requiredEnv("PORT");
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("PORT must be a valid TCP port");
    }
    server = { host: "127.0.0.1", port, strictPort: true };
  }

  return {
    base: `${APP_BASE_PATH}/`,
    define: {
      __TRAYCER_WEBAPP_CONFIG__: JSON.stringify(config),
    },
    plugins: [
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
      outDir: resolve(webappRoot, "dist", "web"),
      sourcemap: false,
    },
    server,
  };
});
