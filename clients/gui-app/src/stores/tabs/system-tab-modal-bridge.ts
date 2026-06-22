import type { SystemTabModalApi } from "@/stores/tabs/use-system-tab-modal";

/**
 * Global handle that lets framework-free modules (router adapter,
 * keybinding dispatch, command-palette sources) drive the modal
 * without owning a React hook context. The `SystemTabModalHost`
 * publishes the live API on mount and clears it on unmount.
 */
let currentApi: SystemTabModalApi | null = null;

export function setSystemTabModalApi(api: SystemTabModalApi | null): void {
  currentApi = api;
}

export function getSystemTabModalApi(): SystemTabModalApi | null {
  return currentApi;
}
