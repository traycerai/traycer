import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";

/**
 * `EpicSessionProvider` keeps the previous handle registered and RENDERED while its replacement establishes and after one fails, and `epic-shell.tsx` makes only the tile subtree inert for that window.
 * ONE HOOK RATHER THAN ONE FIX PER CONSUMER, deliberately.
 */
export function useCanvasHostId(): string | null {
  const sessionHostId = useEpicSessionHostId();
  const effectiveHostId = useEffectiveHostId();
  return sessionHostId ?? effectiveHostId;
}
