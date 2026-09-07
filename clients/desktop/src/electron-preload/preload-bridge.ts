import { contextBridge } from "electron";
import { RunnerHostSync } from "../ipc-contracts/ipc-channels";
import { config } from "../config";
import { readInitialRouteArg } from "../ipc-contracts/window-bootstrap";
import { buildAuthBridge, buildAuthTokenStoreBridge } from "./auth-bridge";
import { buildDeviceFlowBridge } from "./device-flow-bridge";
import { buildHostBridge } from "./host-bridge";
import {
  buildHostControllerStatusSubscriber,
  buildHostManagementBridge,
  buildHostTrayCommandSubscriber,
} from "./host-management-bridge";
import { buildTrayBridge } from "./tray-bridge";
import { buildWindowsBridge } from "./windows-bridge";
import { buildMenuBridge } from "./menu-bridge";
import { buildSupportBridge } from "./support-bridge";
import { buildAppUpdateBridge } from "./app-update-bridge";
import { buildGlobalShortcutsBridge } from "./global-shortcuts-bridge";
import { buildLifecycleBridge } from "./lifecycle-bridge";
import { buildMigrationBridge } from "./migration-bridge";
import { buildServiceBridge } from "./service-bridge";
import { buildTraycerCliBridge } from "./traycer-cli-bridge";
import { buildPlatformBridge } from "./platform-bridge";
import { buildPowerBridge } from "./power-bridge";
import {
  buildFileDropsBridge,
  createNativeClipboardReadGate,
} from "./file-drops-bridge";
import { buildZoomBridge } from "./zoom-bridge";
import { buildBrowserViewBridge } from "./browser-view-bridge";
import {
  buildSelectionAuthorityBridge,
  buildSelectionFleetRefresh,
} from "./selection-authority-bridge";
import { readSyncString } from "./sync-bootstrap";


const windowId = readSyncString(RunnerHostSync.windowId, "primary");
const sentryRendererDsn = readSyncString(RunnerHostSync.sentryRendererDsn, "");
const initialRoute = readInitialRouteArg(process.argv);
const nativeClipboardReadGate = createNativeClipboardReadGate(() => Date.now());
const menuBridge = buildMenuBridge();

window.addEventListener("paste", nativeClipboardReadGate.observePaste, true);

contextBridge.exposeInMainWorld("runnerHost", {
  authnBaseUrl: config.authnBaseUrl,
  relayBaseUrl: config.relayBaseUrl,
  // Runtime-resolved in main (dev loopback port is dynamic), so it must be a
  // sync read rather than a compile-time `config` value. Empty → the renderer
  // uses its compile-time custom-scheme redirect.
  authRedirectUri: readSyncString(RunnerHostSync.authRedirectUri, ""),
  initialRoute,
  sentryRendererDsn,
  ...buildAuthBridge(),
  tokenStore: buildAuthTokenStoreBridge(),
  deviceFlow: buildDeviceFlowBridge(),
  ...buildHostBridge(),
  ...buildTrayBridge(),
  ...buildWindowsBridge(windowId),
  ...menuBridge,
  ...buildSupportBridge(menuBridge.menu.platform),
  ...buildAppUpdateBridge(),
  ...buildGlobalShortcutsBridge(),
  ...buildLifecycleBridge(),
  fileDrops: buildFileDropsBridge(nativeClipboardReadGate),
  service: buildServiceBridge(),
  traycerCli: buildTraycerCliBridge(),
  migration: buildMigrationBridge(),
  platform: buildPlatformBridge(),
  power: buildPowerBridge(),
  ...buildZoomBridge(),
  ...buildBrowserViewBridge(),
  selectionAuthority: buildSelectionAuthorityBridge(),
  refreshSelectionFleet: buildSelectionFleetRefresh(),
  hostManagement: buildHostManagementBridge(),
  hostTray: buildHostTrayCommandSubscriber(),
  hostControllerStatus: buildHostControllerStatusSubscriber(),
});
