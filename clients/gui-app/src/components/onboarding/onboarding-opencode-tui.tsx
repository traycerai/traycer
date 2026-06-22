import { cn } from "@/lib/utils";

interface OnboardingOpencodeTuiProps {
  readonly reducedMotion: boolean;
}

/**
 * Static recreation of the OpenCode terminal UI used inside the onboarding
 * diorama's OpenCode agent pane. Colors come from the shared `--term-ansi-*`
 * tokens so it repaints with the active theme, exactly like the real xterm
 * host. Like a real terminal, the conversation sits at the top and the prompt
 * stays pinned to the bottom; when the pane is short the conversation clips
 * first so the prompt + footer always stay visible.
 */
export function OnboardingOpencodeTui(props: OnboardingOpencodeTuiProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas p-3 font-mono text-code-xs leading-relaxed text-foreground/85">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="border-l-2 border-[var(--term-ansi-blue)]/45 bg-foreground/[0.04] px-2.5 py-1.5 text-foreground">
          verify usage paths outside the API
        </div>
        <p className="text-[var(--term-ansi-yellow)]">+ Thought: 735ms</p>
        <p className="truncate text-foreground/90">
          tracing usage consumption across the billing service…
        </p>
        <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[2px] bg-[var(--term-ansi-blue)]"
          />
          <span className="font-medium text-foreground">Build</span>
          <span className="truncate">· 3.5s</span>
        </p>
      </div>

      <div className="mt-2 flex shrink-0 flex-col gap-1.5">
        <div className="flex items-center border-l-2 border-[var(--term-ansi-blue)] bg-foreground/[0.04] px-2.5 py-2">
          <span
            aria-hidden="true"
            className={cn(
              "inline-block h-3.5 w-2 bg-foreground/80",
              !props.reducedMotion && "animate-pulse",
            )}
          />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 truncate">
            <span className="font-medium text-[var(--term-ansi-blue)]">
              Build
            </span>
            <span className="truncate text-muted-foreground">OpenCode Zen</span>
          </p>
          <p className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <span>13.7K (7%)</span>
            <span className="font-medium text-foreground/70">ctrl+p</span>
            <span>commands</span>
          </p>
        </div>
      </div>
    </div>
  );
}
