import { type ReactNode } from "react";
import clawdUrl from "@/assets/onboarding/clawd.png?url";
import { cn } from "@/lib/utils";

interface OnboardingClaudeTuiProps {
  readonly reducedMotion: boolean;
  // Stacked half-height panes (e.g. screen 3's right-top pane) can't fit the
  // full intro. Compact drops the rules + prompt and tightens spacing so the
  // header and the status line — the load-bearing parts — always stay visible.
  readonly compact: boolean;
  // Terminal scrollback / session output rendered in the body area between the
  // header and the input box. Pass null (or an empty fragment) for the clean
  // intro; pass step-revealed lines for an active session.
  readonly body: ReactNode;
}

/**
 * Static recreation of the Claude Code terminal intro screen used inside the
 * onboarding diorama's terminal pane. Colors come from the shared `--term-ansi-*`
 * tokens so it repaints with the active theme, exactly like the real xterm host.
 */
export function OnboardingClaudeTui(props: OnboardingClaudeTuiProps) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas font-mono text-code-xs leading-relaxed text-foreground/85",
        props.compact ? "gap-1.5 p-2.5" : "gap-2.5 p-3",
      )}
    >
      <div className="flex items-start gap-2.5">
        <ClaudeMascot />
        <div className="min-w-0 flex-1">
          <p className="truncate">
            <span className="font-bold text-foreground">Claude Code</span>{" "}
            <span className="text-muted-foreground">v2.1.183</span>
          </p>
          <p className="truncate text-muted-foreground">Claude Max</p>
          <p className="truncate text-muted-foreground">
            ~/work/billing-service
          </p>
        </div>
      </div>

      {/* Terminal body: caller-injected session output fills this region and
          pushes the input box + status bar to the bottom, like a real terminal.
          Empty (clean intro) when the caller passes no body. */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
        {props.body}
      </div>

      <TuiRule />

      <div className="flex items-center gap-1.5 leading-none text-foreground/70">
        <span className="leading-none">❯</span>
        <span
          className={cn(
            "inline-block h-2.5 w-1.5 bg-foreground/70",
            !props.reducedMotion && "animate-pulse",
          )}
        />
      </div>

      <TuiRule />

      <div className="flex flex-col gap-0.5">
        <p className="truncate">
          <span className="text-[var(--term-ansi-magenta)]">
            billing-service
          </span>{" "}
          <span className="text-muted-foreground">[ctx: </span>
          <span className="text-foreground">33%</span>
          <span className="text-muted-foreground">] [5h: </span>
          <span className="text-[var(--term-ansi-green)]">27%</span>
          <span className="text-muted-foreground"> | wk: </span>
          <span className="text-[var(--term-ansi-green)]">9%</span>
          <span className="text-muted-foreground">]</span>
        </p>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate">
            <span className="text-[var(--term-ansi-yellow)]">
              ▶▶ auto mode on
            </span>{" "}
            <span className="text-muted-foreground">
              · 1 monitor · ← for agents
            </span>
          </p>
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-muted-foreground/70" />
            high
          </span>
        </div>
      </div>
    </div>
  );
}

function TuiRule() {
  return <div aria-hidden="true" className="h-px w-full bg-foreground/35" />;
}

function ClaudeMascot() {
  return (
    <img
      src={clawdUrl}
      alt=""
      aria-hidden="true"
      className="h-[2.1rem] w-auto shrink-0 select-none"
      draggable={false}
    />
  );
}
