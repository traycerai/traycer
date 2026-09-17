import type { ReactNode } from "react";
import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ReportIssueContext } from "@/lib/report-issue-context";
import {
  isReportIssueDraftContext,
  type ReportIssueDraftContext,
} from "@/lib/report-issue-draft-context";
import { cn } from "@/lib/utils";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

interface ReportIssueActionProps {
  /**
   * Either the finished context, or a builder invoked at CLICK time.
   *
   * Prefer the builder whenever the draft's private diagnostics depend on
   * support-registry state (`getSupportContextSnapshot`): that registry is
   * written from effects (`SupportContextRegistryBridge`), so it trails the
   * render that mounted this button - a durable transcript row would
   * otherwise freeze the chat/harness that was active one or more commits
   * BEFORE the bridge published the one the row belongs to, and the harness
   * id is also the fingerprint's `causalProvider`, so a stale snapshot
   * misclusters the report as well as mislabelling it.
   *
   * The eager forms stay right for surfaces that render in direct response to
   * the failure they report (the error boundaries), where render time IS
   * report time.
   */
  readonly context:
    | ReportIssueContext
    | ReportIssueDraftContext
    | (() => ReportIssueDraftContext);
  readonly presentation: "text" | "icon" | "link";
  /**
   * The quiet Button variant this action wears. `muted` is right everywhere
   * the action sits in ordinary chrome; inside a warning or error banner the
   * glyph belongs to the banner's role, so those callers pass the matching
   * status variant instead of tinting the button from outside.
   *
   * `link` presentation ignores it: that one renders inside a sentence and
   * takes the colour of the text around it.
   */
  readonly variant?: "muted" | "warning-ghost" | "destructive-ghost";
  readonly className: string | undefined;
}

export function ReportIssueAction(props: ReportIssueActionProps): ReactNode {
  const reportIssueAvailable = useDesktopDialogStore(
    (state) => state.reportIssueAvailable,
  );
  const openReportIssueWithContext = useDesktopDialogStore(
    (state) => state.openReportIssueWithContext,
  );
  const openReportIssueDraft = useDesktopDialogStore(
    (state) => state.openReportIssueDraft,
  );
  if (!reportIssueAvailable) return null;

  const handleClick = () => {
    // Resolved BEFORE the track call so the event can name the surface. Both
    // still happen inside this one click, so the builder's whole reason for
    // being lazy - reading a support-registry snapshot that trails render -
    // is unaffected.
    const context =
      typeof props.context === "function" ? props.context() : props.context;
    Analytics.getInstance().track(AnalyticsEvent.ReportIssueOpened, {
      source: "direct_ui",
      surface: isReportIssueDraftContext(context)
        ? context.publicPrefill.source
        : context.source,
    });
    if (isReportIssueDraftContext(context)) {
      openReportIssueDraft(context);
    } else {
      openReportIssueWithContext(context);
    }
  };

  if (props.presentation === "text") {
    return (
      <Button
        type="button"
        size="sm"
        variant={props.variant ?? "muted"}
        className={cn(props.className)}
        onClick={handleClick}
      >
        <Bug aria-hidden />
        Report issue
      </Button>
    );
  }

  if (props.presentation === "link") {
    return (
      // `inline-xs` + `text-current`: this presentation renders INSIDE a
      // sentence ("... couldn't load. Report issue."), so it must reserve no
      // box of its own and must take the colour of the paragraph rather than
      // `link`'s `text-primary`. Every call site used to spell that out as
      // `h-auto p-0 text-current`; it belongs here, once.
      <Button
        type="button"
        size="inline-xs"
        variant="link"
        className={cn("text-current", props.className)}
        onClick={handleClick}
      >
        Report issue
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant={props.variant ?? "muted"}
          className={cn(props.className)}
          aria-label="Report issue"
          onClick={handleClick}
        >
          <Bug aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Report issue</TooltipContent>
    </Tooltip>
  );
}
