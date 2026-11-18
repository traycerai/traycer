import { useEffect, useMemo } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { CollabUser } from "@/editor-core/awareness/derive-collab-user";
import { createCursorThrottle, type CanvasPoint } from "./canvas-model";

export function useCanvasPointer(
  awareness: Awareness | null,
  artifactId: string,
  page: string,
  user: CollabUser,
) {
  const publisher = useMemo(
    () =>
      createCursorThrottle<CanvasPoint>((point) => {
        awareness?.setLocalStateField("canvasCursor", {
          ...point,
          artifactId,
          page,
          user,
        });
      }),
    [awareness, artifactId, page, user],
  );
  const clear = useMemo(
    () => (): void => {
      publisher.cancel();
      awareness?.setLocalStateField("canvasCursor", null);
    },
    [publisher, awareness],
  );
  useEffect(() => clear, [clear]);
  return { publish: publisher.push, clear };
}
