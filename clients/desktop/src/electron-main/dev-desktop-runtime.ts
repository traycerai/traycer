import type { Environment } from "../config";
import { devDesktopSlotForEnvironment } from "./host/dev-desktop-slot";

export const DEV_DESKTOP_DISPLAY_NAME_ENV = "TRAYCER_DESKTOP_DEV_DISPLAY_NAME";

export interface DesktopRuntimeIdentity {
  readonly appName: string;
  readonly userDataDirName: string | null;
  readonly slot: string | null;
}

export function resolveDesktopRuntimeIdentity(
  baseAppName: string,
  environment: Environment,
  env: NodeJS.ProcessEnv,
): DesktopRuntimeIdentity {
  const slot = devDesktopSlotForEnvironment(environment, env);
  if (slot === null) {
    return {
      appName: baseAppName,
      userDataDirName: null,
      slot: null,
    };
  }
  const displayName = env[DEV_DESKTOP_DISPLAY_NAME_ENV];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(
      `${DEV_DESKTOP_DISPLAY_NAME_ENV} is required when DEV_DESKTOP_SLOT is set`,
    );
  }
  return {
    appName: displayName,
    userDataDirName: `${baseAppName}-${slot}`,
    slot,
  };
}
