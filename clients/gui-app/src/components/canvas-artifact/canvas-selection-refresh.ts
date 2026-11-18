import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasBox, CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { CanvasSelection } from "./canvas-selection-store";

export function selectionMatches(
  selection: CanvasSelection | null,
  identity: {
    readonly artifactId: string;
    readonly boardPath: string;
    readonly marker: number | null;
    readonly tid: string | null;
  },
): selection is CanvasSelection {
  return (
    selection !== null &&
    selection.artifactId === identity.artifactId &&
    selection.boardPath === identity.boardPath &&
    selection.element.marker === identity.marker &&
    selection.element.tid === identity.tid
  );
}

export async function selectedCanvasBox(
  bridge: SandboxBridgeHost,
  element: CanvasElement,
): Promise<CanvasBox | null> {
  if (element.tid !== null) return bridge.elementBox({ tid: element.tid });
  if (element.marker !== null)
    return bridge.elementBox({ marker: element.marker });
  const found = await bridge.hitTest({
    x: element.box.x + element.box.width / 2,
    y: element.box.y + element.box.height / 2,
  });
  return found?.selector === element.selector ? found.box : null;
}

export function sameCanvasBox(a: CanvasBox, b: CanvasBox): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}
