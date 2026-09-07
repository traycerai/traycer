import { join } from "node:path";
import { config, isDevBuild } from "../../config";
import type { Environment } from "../host/host-paths";


export interface DesktopConfig {
  // The build's deploy slot (`dev` / `staging` / `production`).
  readonly environment: Environment;
  // True for the dev slot (gates the updater + dev-only menu items).
  readonly isDev: boolean;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly authnBaseUrl: string;
}

export function resolveDesktopConfig(): DesktopConfig {
  return {
    // The host slot follows the build's environment (dev / staging /
    // production), so a packaged staging app and a real prod install can run
    // side by side. `make dev-desktop` runs from source → environment "dev".
    environment: config.environment,
    isDev: isDevBuild,
    // Every slot co-locates the preload next to the main bundle:
    // `dist/main/index.js` → `dist/preload/index.js`.
    preloadPath: join(__dirname, "..", "preload", "index.js"),
    iconPath: resolveAppIconPath(),
    authnBaseUrl: config.authnBaseUrl,
  };
}

function resolveAppIconPath(): string {
  // Shipped: bundled under `<resources>/app`. Dev slot: the bundle runs from
  // `dist/main`, so the workspace icon sits at `../../resources/app`
  // relative to it.
  return isDevBuild
    ? join(__dirname, "..", "..", "resources", "app", "traycer-icon.png")
    : join(process.resourcesPath, "app", "traycer-icon.png");
}
