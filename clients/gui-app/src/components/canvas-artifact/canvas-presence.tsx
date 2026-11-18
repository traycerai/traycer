import { useMemo, useSyncExternalStore, type CSSProperties } from "react";
import type { Awareness } from "y-protocols/awareness";
import { z } from "zod";
import { MousePointer2 } from "lucide-react";
import type { Viewport } from "@xyflow/react";
import type { CollabUser } from "@/editor-core/awareness/derive-collab-user";

const cursorSchema = z.object({
  artifactId: z.string(),
  page: z.string(),
  x: z.number(),
  y: z.number(),
  user: z.object({
    name: z.string().max(200),
    color: z.string().regex(/^#[\da-f]{6}$/i),
  }),
});
interface CanvasCursor {
  readonly clientId: number;
  readonly x: number;
  readonly y: number;
  readonly user: CollabUser;
}
const EMPTY: readonly CanvasCursor[] = [];
function cursorStore(
  awareness: Awareness | null,
  artifactId: string,
  page: string,
) {
  let snapshot: readonly CanvasCursor[] = EMPTY;
  const read = (): void => {
    snapshot = [];
    if (awareness === null) return;
    const next: CanvasCursor[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const parsed = cursorSchema.safeParse(state["canvasCursor"]);
      if (
        parsed.success &&
        parsed.data.artifactId === artifactId &&
        parsed.data.page === page
      )
        next.push({ clientId, ...parsed.data });
    }
    snapshot = next;
  };
  read();
  return {
    getSnapshot: (): readonly CanvasCursor[] => snapshot,
    subscribe: (notify: () => void): (() => void) => {
      const update = (): void => {
        read();
        notify();
      };
      awareness?.on("change", update);
      update();
      return () => awareness?.off("change", update);
    },
  };
}
export function CanvasCursors({
  awareness,
  artifactId,
  page,
  viewport,
}: {
  readonly awareness: Awareness | null;
  readonly artifactId: string;
  readonly page: string;
  readonly viewport: Viewport;
}) {
  const store = useMemo(
    () => cursorStore(awareness, artifactId, page),
    [awareness, artifactId, page],
  );
  const cursors = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {cursors.map((cursor) => (
        <div
          key={cursor.clientId}
          className="absolute flex items-start gap-1 text-(--canvas-cursor-color)"
          style={
            {
              transform: `translate(${cursor.x * viewport.zoom + viewport.x}px, ${cursor.y * viewport.zoom + viewport.y}px)`,
              "--canvas-cursor-color": cursor.user.color,
            } as CSSProperties
          }
        >
          <MousePointer2 className="size-4 fill-current" />
          <span className="rounded-sm bg-popover px-1.5 py-0.5 text-ui-xs shadow-sm">
            {cursor.user.name}
          </span>
        </div>
      ))}
    </div>
  );
}
