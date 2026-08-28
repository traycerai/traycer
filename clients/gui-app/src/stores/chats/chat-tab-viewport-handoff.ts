/**
 * Compatibility seam for canvas actions that already flush chat view ids.
 * Registrations and storage now belong to the global capture registry, so
 * chat and non-chat structural handoffs have one authority.
 */
import {
  flushLiveReadingPositionViews,
  registerReadingPositionCapture,
} from "@/lib/reading-position/service";
import type { ReadingPositionIdentity } from "@/lib/reading-position/types";

type ChatTabViewportCapture = () => void;

export function registerChatTabViewportCapture(
  instanceId: string,
  capture: ChatTabViewportCapture,
  identity: ReadingPositionIdentity,
): () => void {
  return registerReadingPositionCapture({
    captureKey: instanceId,
    identity: { ...identity, viewKey: instanceId },
    capture,
  });
}

export function flushChatTabViewportHandoff(
  instanceIds: ReadonlyArray<string>,
): void {
  flushLiveReadingPositionViews(instanceIds);
}
