import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { createDraftAndReplaceRoute } from "@/lib/draft-entry-route";

export function DraftNewRoute() {
  const navigate = useNavigate();
  const didCreateRef = useRef(false);

  useEffect(() => {
    if (didCreateRef.current) return;
    didCreateRef.current = true;
    createDraftAndReplaceRoute(navigate);
  }, [navigate]);

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
