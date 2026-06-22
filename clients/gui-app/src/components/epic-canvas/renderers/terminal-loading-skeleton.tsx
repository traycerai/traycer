import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/**
 * Shared loading state for terminal / terminal-agent tiles: the xterm Suspense
 * fallback, the host-reachability check, and the whole terminal-agent
 * create→ready window (projection load, launch prep, session start) all render
 * this - so creating a terminal agent reads as one continuous skeleton into the
 * live xterm rather than a sequence of placeholder strings.
 */
export function TerminalLoadingSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 bg-canvas text-ui-sm text-muted-foreground">
      <span>Starting terminal</span>
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}
