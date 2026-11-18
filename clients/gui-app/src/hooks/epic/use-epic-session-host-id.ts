import { use } from "react";
import {
  EpicSessionContext,
  getEpicSessionHandleHostId,
} from "@/lib/registries/epic-session-registry";

/**
 * The host that owns the surrounding Epic session.
 *
 * The Epic sidebar is a sibling of the canvas, so it is intentionally outside
 * every per-tile `<TabHostProvider>`. Host RPCs issued by the sidebar must use
 * the session transport's host instead of trying to read a tile binding (or
 * independently re-reading the app-wide active host).
 */
export function useEpicSessionHostId(): string | null {
  const handle = use(EpicSessionContext);
  return handle === null ? null : getEpicSessionHandleHostId(handle);
}
