import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  DesktopAppUpdatesBridge,
  DesktopHostControllerStatusBridge,
  DesktopMenuBridge,
  DesktopPowerBridge,
  DesktopSupportBridge,
  DesktopZoomBridge,
} from "@/lib/windows/types";

export function resolveDesktopMenuBridge(
  runnerHost: IRunnerHost,
): DesktopMenuBridge | null {
  const value: unknown = Reflect.get(runnerHost, "menu");
  return isDesktopMenuBridge(value) ? value : null;
}

export function resolveDesktopSupportBridge(
  runnerHost: IRunnerHost,
): DesktopSupportBridge | null {
  const value: unknown = Reflect.get(runnerHost, "support");
  return isDesktopSupportBridge(value) ? value : null;
}

export function resolveDesktopAppUpdatesBridge(
  runnerHost: IRunnerHost,
): DesktopAppUpdatesBridge | null {
  const value: unknown = Reflect.get(runnerHost, "appUpdates");
  return isDesktopAppUpdatesBridge(value) ? value : null;
}

export function resolveDesktopPowerBridge(
  runnerHost: IRunnerHost,
): DesktopPowerBridge | null {
  const value: unknown = Reflect.get(runnerHost, "power");
  return isDesktopPowerBridge(value) ? value : null;
}

export function resolveDesktopZoomBridge(
  runnerHost: IRunnerHost,
): DesktopZoomBridge | null {
  const value: unknown = Reflect.get(runnerHost, "zoom");
  return isDesktopZoomBridge(value) ? value : null;
}

export function resolveDesktopHostControllerStatusBridge(
  runnerHost: IRunnerHost,
): DesktopHostControllerStatusBridge | null {
  const value: unknown = Reflect.get(runnerHost, "hostControllerStatus");
  return isDesktopHostControllerStatusBridge(value) ? value : null;
}

function isDesktopMenuBridge(value: unknown): value is DesktopMenuBridge {
  return isRecord(value) && typeof value.onCommand === "function";
}

function isDesktopSupportBridge(value: unknown): value is DesktopSupportBridge {
  return (
    isRecord(value) &&
    typeof value.getSnapshot === "function" &&
    typeof value.revealLog === "function" &&
    typeof value.submitReport === "function"
  );
}

function isDesktopAppUpdatesBridge(
  value: unknown,
): value is DesktopAppUpdatesBridge {
  return (
    isRecord(value) &&
    typeof value.getSnapshot === "function" &&
    typeof value.checkForUpdates === "function" &&
    typeof value.setAllowPrerelease === "function" &&
    typeof value.downloadUpdate === "function" &&
    typeof value.installUpdate === "function" &&
    typeof value.onChange === "function"
  );
}

function isDesktopPowerBridge(value: unknown): value is DesktopPowerBridge {
  return isRecord(value) && typeof value.setSleepBlocked === "function";
}

function isDesktopZoomBridge(value: unknown): value is DesktopZoomBridge {
  return (
    isRecord(value) &&
    Array.isArray(value.ladder) &&
    typeof value.get === "function" &&
    typeof value.set === "function" &&
    typeof value.stepIn === "function" &&
    typeof value.stepOut === "function" &&
    typeof value.reset === "function" &&
    typeof value.onChange === "function"
  );
}

function isDesktopHostControllerStatusBridge(
  value: unknown,
): value is DesktopHostControllerStatusBridge {
  return isRecord(value) && typeof value.onChange === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
