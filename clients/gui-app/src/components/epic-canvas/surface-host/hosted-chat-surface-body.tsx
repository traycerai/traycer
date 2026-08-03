/**
 * Ticket 21 slice 4: the real `StableTileSurfaceHost.renderRecordBody` for a
 * hosted chat - `TopLevelTabHost`'s only call site.
 *
 * `HostedChatSurfaceContextBridge` bridges the small set of ambient contexts
 * a chat's render tree actually consumes (design-review's provider
 * inventory), then calls the REAL `renderTile` - unmodified - so
 * `TabHostProvider` and `TileFindScope` are reused verbatim rather than
 * cloned. Everything else in `ChatTile`'s chain (`useEpicPermissionRole`,
 * `useEpicSnapshotLoaded`, `useEpicArtifact`, ...) resolves through
 * `useEpicStore`, which itself only ever reads `EpicSessionContext` -
 * bridging that ONE context is what makes the whole chain work with no
 * further wiring. Never mount a second `EpicSessionProvider`; the bridge
 * only re-provides the SAME handle the real provider (still an ancestor of
 * the publishing `TileSurfaceSlot`) already produced.
 */
import type { ReactNode } from "react";
import { HostedChatSurfaceContextBridge } from "@/components/epic-canvas/surface-host/hosted-chat-surface-context-bridge";
import type { ReadyTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";

export function renderHostedChatSurfaceBody(
  environment: ReadyTileSurfaceEnvironment,
): ReactNode {
  return <HostedChatSurfaceContextBridge environment={environment} />;
}
