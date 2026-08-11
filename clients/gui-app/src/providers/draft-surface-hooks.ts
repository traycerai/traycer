import { use } from "react";
import { DraftSurfaceContext } from "@/providers/draft-surface-context";

export function useDraftSurfaceId(): string | null {
  return use(DraftSurfaceContext);
}
