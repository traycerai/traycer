import { use } from "react";
import {
  EpicSessionContext,
  getEpicSessionHandleHostId,
} from "@/lib/registries/epic-session-registry";

/** Host RPCs issued by the sidebar must use the session transport's host instead of trying to read a tile binding (or independently re-reading the app-wide active host). */
export function useEpicSessionHostId(): string | null {
  const handle = use(EpicSessionContext);
  return handle === null ? null : getEpicSessionHandleHostId(handle);
}
