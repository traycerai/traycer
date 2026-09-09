import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * Builds a routed `HostRequester` bound to the CURRENT tab's host
 * (`useTabHostId`) rather than the app-wide active host.
 *
 * Per CLAUDE.md a chat/terminal tab is bound to a host for life, and that
 * host can differ from the renderer-default one (a tab bound to a remote /
 * non-default host). RPCs that must hit the host a tab's terminals actually
 * live on - e.g. setup-terminal liveness (`terminal.list`) and Cancel
 * (`terminal.kill`) - resolve their client here so they never silently switch
 * host scope by render context.
 *
 * This is the in-tab form of `useHostClientForHostId`: the tab id is
 * non-null, so it always takes that hook's identity-requester path. The
 * requester re-reads the runtime's live directory row on every access. Sharing
 * that one resolution matters because a
 * tab composer hands the SAME id to surfaces mounted beside it as a plain
 * `runTargetHostId` (the model picker, `ProviderProfileAddFlowHost`), which
 * resolve through `useHostClientForHostId` directly - so the toolbar store's
 * client and the picker's client represent the same identity in the same
 * paint.
 *
 * The client remains non-null while the row is absent, its RPC endpoint is
 * absent, or the user is signed out. Its reactive readiness owns those
 * execution gates, so a booting host can recover on the generic endpoint edge
 * without reconstructing this requester.
 *
 * Must be called inside `<TabHostProvider>` (every tile renderer is wrapped).
 */
export function useTabHostClient(): HostClient<HostRpcRegistry> | null {
  return useHostClientForHostId(useTabHostId());
}
