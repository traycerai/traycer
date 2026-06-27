import { contextBridge } from "electron";
import { RunnerHostSync } from "../ipc-contracts/ipc-channels";
import { config } from "../config";
import { readInitialRouteArg } from "../ipc-contracts/window-bootstrap";
import { buildAuthBridge } from "./auth-bridge";
import { buildDeviceFlowBridge } from "./device-flow-bridge";
import { buildHostBridge } from "./host-bridge";
import {
  buildHostManagementBridge,
  buildHostTrayCommandSubscriber,
} from "./host-management-bridge";
import { buildTrayBridge } from "./tray-bridge";
import { buildWindowsBridge } from "./windows-bridge";
import { buildMenuBridge } from "./menu-bridge";
import { buildSupportBridge } from "./support-bridge";
import { buildAppUpdateBridge } from "./app-update-bridge";
import { buildLifecycleBridge } from "./lifecycle-bridge";
import { buildMigrationBridge } from "./migration-bridge";
import { buildServiceBridge } from "./service-bridge";
import { buildTraycerCliBridge } from "./traycer-cli-bridge";
import { buildPlatformBridge } from "./platform-bridge";
import { buildPowerBridge } from "./power-bridge";
import { buildFileDropsBridge } from "./file-drops-bridge";
import { readSyncString } from "./sync-bootstrap";

/**
 * Preload script exposing an `IRunnerHost`-shaped bridge through
 * `contextBridge.exposeInMainWorld('runnerHost', …)`. The renderer entry
 * (`src/renderer-shell/main.tsx`) wraps this bridge into a `DesktopRunnerHost`
 * that implements the shared
 * `@traycer-clients/shared/platform/runner-host` interface.
 *
 * Because `contextIsolation` is enabled, only serializable values and
 * registered functions cross the bridge. Per-feature bridge surfaces (auth,
 * host, tray, windows, menu, support, lifecycle) live in sibling
 * `*-bridge.ts` files; importing them registers their eager `ipcRenderer.on`
 * subscriptions at module load. This entry only composes them into the final
 * `runnerHost` object.
 */

const windowId = readSyncString(RunnerHostSync.windowId, "primary");
const sentryRendererDsn = readSyncString(RunnerHostSync.sentryRendererDsn, "");
const initialRoute = readInitialRouteArg(process.argv);

contextBridge.exposeInMainWorld("runnerHost", {
  authnBaseUrl: config.authnBaseUrl,
  // Runtime-resolved in main (dev loopback port is dynamic), so it must be a
  // sync read rather than a compile-time `config` value. Empty → the renderer
  // uses its compile-time custom-scheme redirect.
  authRedirectUri: readSyncString(RunnerHostSync.authRedirectUri, ""),
  initialRoute,
  sentryRendererDsn,
  ...buildAuthBridge(),
  deviceFlow: buildDeviceFlowBridge(),
  ...buildHostBridge(),
  ...buildTrayBridge(),
  ...buildWindowsBridge(windowId),
  ...buildMenuBridge(),
  ...buildSupportBridge(),
  ...buildAppUpdateBridge(),
  ...buildLifecycleBridge(),
  fileDrops: buildFileDropsBridge(),
  service: buildServiceBridge(),
  traycerCli: buildTraycerCliBridge(),
  migration: buildMigrationBridge(),
  platform: buildPlatformBridge(),
  power: buildPowerBridge(),
  hostManagement: buildHostManagementBridge(),
  hostTray: buildHostTrayCommandSubscriber(),
});
