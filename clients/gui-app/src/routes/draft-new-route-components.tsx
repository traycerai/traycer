import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { createDraftAndReplaceRoute } from "@/lib/draft-entry-route";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";

export function DraftNewRoute() {
  const navigate = useNavigate();
  // In Electron the `/` guard may redirect here off a stale-empty store read
  // (the per-window snapshot lands asynchronously). Wait for the windows-bridge
  // snapshot before deciding, so we don't mint a spurious draft over restored
  // content. In the browser there is no snapshot: `useWindowsBridgeHydrated()`
  // reports `true` immediately, so this gate is a no-op there.
  const hydrated = useWindowsBridgeHydrated();
  const didActRef = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    if (didActRef.current) return;
    didActRef.current = true;
    // Hydration may have revealed tabs/drafts the stale `/` read missed, or a
    // draft this window already minted (guards the signed-out → signed-in
    // `beforeLoad` replay against a duplicate mint). Hand the user back to the
    // restored workspace instead of creating another draft.
    if (hasRestoredTabs()) {
      void navigate({ to: "/", replace: true });
      return;
    }
    createDraftAndReplaceRoute(navigate);
  }, [hydrated, navigate]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}
