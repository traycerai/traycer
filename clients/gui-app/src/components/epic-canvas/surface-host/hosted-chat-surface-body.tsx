/** Renders a chat in the stable host with its publishing surface's contexts. */
import type { ReactNode } from "react";
import { HostedChatSurfaceContextBridge } from "@/components/epic-canvas/surface-host/hosted-chat-surface-context-bridge";
import type { ReadyTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";

export function renderHostedChatSurfaceBody(
  environment: ReadyTileSurfaceEnvironment,
): ReactNode {
  return <HostedChatSurfaceContextBridge environment={environment} />;
}
