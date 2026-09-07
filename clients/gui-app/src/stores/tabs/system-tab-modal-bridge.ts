import { useSyncExternalStore } from "react";
import type { SystemTabModalApi } from "@/stores/tabs/use-system-tab-modal";

/**
 * Global handle that lets framework-free modules (router adapter, keybinding dispatch,
 * command-palette sources) drive the modal without owning a React hook context.
 */
let currentApi: SystemTabModalApi | null = null;
const listeners = new Set<() => void>();

export function setSystemTabModalApi(api: SystemTabModalApi | null): void {
  currentApi = api;
  for (const listener of [...listeners]) listener();
}

export function getSystemTabModalApi(): SystemTabModalApi | null {
  return currentApi;
}

/**
 * Whether an API is published right now, for a surface that must not offer a Settings navigation
 * before there is a host to receive it: the host mounts behind `HostReadyGate`, so on a cold
 */
export function useSystemTabModalApiPublished(): boolean {
  return useSyncExternalStore(subscribe, isPublished, isPublished);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isPublished(): boolean {
  return currentApi !== null;
}
