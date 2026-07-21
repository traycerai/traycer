import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useRefreshProvidersListOnTurn } from "@/hooks/providers/use-refresh-providers-list-on-turn";

/**
 * Default-host-scoped sibling of `useRefreshProvidersListOnTurn` for surfaces
 * with no tab-bound host of their own - the landing composer, which reads
 * `providers.list` for the app-wide default host (`useHostClient()`) rather
 * than a `useTabHostId()` binding. `subscribeChatTurnCompletions` is already
 * global (every open chat session, any epic, including backgrounded ones via
 * the warm session registry), so this only differs from the tab-scoped hook
 * in which host's cached list it invalidates - `useReactiveActiveHostId()`
 * here instead of a tab id, matching the `hostId` `useHostQuery` derives from
 * the same default client's `getActiveHostId()`.
 */
export function useRefreshProvidersListOnTurnDefaultHost(
  harnessId: GuiHarnessId | null,
): void {
  const defaultHostId = useReactiveActiveHostId();
  useRefreshProvidersListOnTurn(harnessId, defaultHostId);
}
