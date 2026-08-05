import { CircleAlert, TimerReset } from "lucide-react";
import type { GitWatcherStatus } from "@traycer/protocol/host/git-schemas";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface GitWatcherStatusNoticeProps {
  /** `null` when the host predates `git.subscribeStatus@1.3`, or pre-first-frame. */
  readonly status: GitWatcherStatus | null;
  readonly className: string | undefined;
  /**
   * Icon-only. For toolbars that share a narrow pane - a diff tile can be
   * dragged to a 240px minimum, where a non-shrinking two-word label next to
   * three or four icon controls overflows and clips them.
   *
   * Nothing is lost: the tooltip still carries the whole explanation and the
   * remedy, and the trigger keeps an accessible name, so keyboard and
   * assistive-tech users read exactly what the wide form says.
   */
  readonly compact: boolean;
}

interface NoticeCopy {
  readonly label: string;
  readonly explanation: string;
}

/**
 * Only the two DEGRADED states render. `watching` needs no affordance (it is
 * the expectation), and `starting` is transient by construction - the host
 * cannot arm its watcher until the first poll resolves the repo root, so every
 * subscription passes through it. Rendering `starting` would put a notice on
 * screen for a moment on every single tab open.
 *
 * `null` renders nothing too, and that is a deliberate refusal to guess: it
 * means the host never told us, not that all is well.
 */
function noticeCopyFor(status: GitWatcherStatus): NoticeCopy | null {
  if (status.state === "degraded-capacity") {
    return {
      label: "Periodic refresh",
      explanation:
        "This machine is out of filesystem watches, so Git changes refresh on a timer instead of instantly. Raising the system watch limit restores live updates - they resume on their own once watches free up.",
    };
  }
  if (status.state === "degraded-error") {
    return {
      label: "Periodic refresh",
      explanation:
        "The filesystem watcher stopped, so Git changes refresh on a timer instead of instantly. Everything stays accurate, just slower to appear. Restarting the host restores live updates.",
    };
  }
  return null;
}

/**
 * A quiet marker that this repo's Git changes are arriving on a poll rather
 * than on filesystem events.
 *
 * Deliberately not a banner, toast or blocking state: polling is CORRECT, only
 * slower - every tick recomputes the full changeset, so nothing is ever missed,
 * it just surfaces with up to ~30s of delay. The point is to make the delay
 * explicable rather than to demand action.
 */
export function GitWatcherStatusNotice(props: GitWatcherStatusNoticeProps) {
  const status = props.status;
  if (status === null) return null;
  const copy = noticeCopyFor(status);
  if (copy === null) return null;

  const permanent = status.state === "degraded-error";
  const Icon = permanent ? CircleAlert : TimerReset;

  return (
    <Tooltip>
      {/* A real focusable trigger, NOT an `asChild` span. The tooltip carries
          the entire explanation and the remedy, so a non-focusable trigger
          would leave keyboard-only users with the two-word label and no way to
          reach the reason for it. Radix's default trigger is a button, which
          also gives the label to assistive tech. */}
      <TooltipTrigger
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5",
          "text-ui-xs text-muted-foreground/70",
          "cursor-default select-none",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
          props.className,
        )}
        data-testid="git-watcher-status-notice"
        data-watcher-state={status.state}
        // Carries the label when the text is not rendered, so the compact form
        // is not an unnamed button to assistive tech.
        aria-label={props.compact ? copy.label : undefined}
      >
        <Icon className="size-3.5 text-muted-foreground/60" />
        {props.compact ? null : copy.label}
      </TooltipTrigger>
      {/* No width cap here: `TooltipContent` already applies `w-fit max-w-xs`,
          so this was a redundant restatement of the primitive's own value.
          Whether that cap should be viewport-bounded is a question about the
          shared primitive and every tooltip in the app, not about this one. */}
      <TooltipContent className={undefined}>
        {/* Block wrapper, not two bare siblings: `TooltipContent` is an
            `inline-flex` ROW, so an explanation and a diagnostic placed
            directly inside it become side-by-side columns and each wraps into
            a narrow ribbon. One flex item that stacks internally is the fix
            that doesn't reach into the shared primitive. */}
        <div className="w-full">
          <p>{copy.explanation}</p>
          {status.detail === null ? null : (
            // Host diagnostics, rendered verbatim and never parsed: the wording
            // is unstable by contract, which is exactly why it is not schema.
            //
            // Toned against `background`, not `muted-foreground`: this surface
            // is INVERSE (`bg-foreground`/`text-background`), so the muted
            // token - designed to sit on `bg-background` - lands dark-on-dark
            // in light themes and washes out in dark ones, obscuring the one
            // line that carries the remedy.
            <p className="mt-1 text-background/70">{status.detail}</p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
