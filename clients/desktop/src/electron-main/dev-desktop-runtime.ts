import type { Environment } from "../config";
import { devDesktopSlotForEnvironment } from "./host/dev-desktop-slot";

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
  return {
    appName: `${baseAppName} — ${displayNameForDevDesktopSlot(slot)}`,
    userDataDirName: `${baseAppName}-${slot}`,
    slot,
  };
}

function displayNameForDevDesktopSlot(slot: string): string {
  if (/^traycer-[a-f0-9]{8}$/.test(slot)) {
    return slot;
  }
  const worktreeMatch = /^(?:traycer-)?(.+)-[a-f0-9]{8}$/.exec(slot);
  return worktreeMatch?.[1] ?? slot;
}
