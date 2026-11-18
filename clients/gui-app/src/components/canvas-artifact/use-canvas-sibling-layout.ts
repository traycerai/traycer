import { useEffect, useState, useSyncExternalStore } from "react";
import type { CanvasSiblingLayout } from "@/lib/sandbox/canvas-layout-bridge";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { frameLocator, sameLayoutElement } from "./canvas-structure-identity";

export function useCanvasSiblingLayout(
  selection: CanvasSelection,
  registry: CanvasFrameRegistry,
): CanvasSiblingLayout | null {
  useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const entry = registry.get(selection.boardPath);
  const [answer, setAnswer] = useState<{
    bridge: SandboxBridgeHost;
    sha256: string;
    identity: string;
    layout: CanvasSiblingLayout;
  } | null>(null);
  const bridge = entry.bridge;
  const sha256 = entry.sha256;
  const { artifactId, boardPath, servedSha256 } = selection;
  const { marker, tid, tagName } = selection.element;
  const identity = `${marker}:${tid}:${tagName}`;
  useEffect(() => {
    const locator = frameLocator({ marker, tid, tagName });
    if (bridge === null || locator === null || sha256 !== servedSha256) return;
    let active = true;
    let pending = false;
    const refresh = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const layout = await bridge.siblingLayout(locator);
        const mounted = registry.get(boardPath);
        const current = useCanvasSelectionStore.getState().selection;
        if (
          !active ||
          mounted.bridge !== bridge ||
          mounted.sha256 !== sha256 ||
          current === null ||
          current.artifactId !== artifactId ||
          current.boardPath !== boardPath ||
          current.servedSha256 !== servedSha256 ||
          !sameLayoutElement(current.element, { marker, tid, tagName })
        )
          return;
        if (layout === null) {
          setAnswer(null);
          return;
        }
        setAnswer((previous) =>
          previous?.bridge === bridge &&
          previous.sha256 === sha256 &&
          previous.identity === identity &&
          JSON.stringify(previous.layout) === JSON.stringify(layout)
            ? previous
            : { bridge, sha256, identity, layout },
        );
      } catch {
        if (active) setAnswer(null);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // Only identity changes restart the reader; geometry is its output.
  }, [
    bridge,
    sha256,
    servedSha256,
    artifactId,
    boardPath,
    marker,
    tid,
    tagName,
    identity,
    registry,
  ]);
  return answer?.bridge === bridge &&
    sha256 === servedSha256 &&
    answer.sha256 === servedSha256 &&
    answer.identity === identity
    ? answer.layout
    : null;
}
