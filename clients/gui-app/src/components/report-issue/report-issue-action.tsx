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
        variant="ghost"
        className={cn("text-muted-foreground", props.className)}
        onClick={handleClick}
      >
        <Bug aria-hidden />
        Report issue
      </Button>
    );
  }

  if (props.presentation === "link") {
    return (
      <Button
        type="button"
        size="xs"
        variant="link"
        className={props.className}
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
          variant="ghost"
          className={cn("text-muted-foreground", props.className)}
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
