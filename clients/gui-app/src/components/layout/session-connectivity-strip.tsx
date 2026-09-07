import type { ReactNode } from "react";
import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  isAnnouncedInterruption,
  useHostSessionConnectivity,
  useHostSessionWake,
} from "@/lib/host/session-connectivity";

/** The session plane is the one fact the narrator cannot own. */
export function SessionConnectivityStrip(): ReactNode {
  const connectivity = useHostSessionConnectivity();
  const wakeSession = useHostSessionWake();
  if (!isAnnouncedInterruption(connectivity)) return null;
  return (
    <output
      aria-label="Connection to Traycer Host interrupted"
      data-testid="session-connectivity-strip"
      data-state={connectivity}
      className="flex w-full items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-ui-xs text-amber-950 dark:text-amber-100"
    >
      <PlugZap className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {connectivity === "interrupted-prolonged"
          ? "Still can't connect - retrying."
          : "Connection interrupted - reconnecting…"}
      </span>
      <AgentSpinningDots
        className="size-3"
        testId="session-connectivity-strip-spinner"
        variant={undefined}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-current"
        data-testid="session-connectivity-strip-retry"
        onClick={wakeSession}
      >
        Retry now
      </Button>
    </output>
  );
}
