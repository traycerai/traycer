import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { classifyHref } from "@/markdown/links/classify-href";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const MARKDOWN_LINK_REPORT_CONTEXT = createReportIssueContext({
  title: "Markdown link could not be opened",
  message: "The requested markdown link could not be opened.",
  code: null,
  source: "Markdown link",
});

interface MarkdownAnchorProps {
  href?: string;
  title?: string;
  className?: string;
  children?: ReactNode;
  node?: unknown;
  [key: string]: unknown;
}

/**
 * Anchor renderer for all markdown surfaces. React-markdown's default `<a>`
 * lets the browser perform a real navigation on click, which in this SPA
 * unloads the React app (the chat-link routing crash). We intercept every
 * click and route links that leave the current document explicitly:
 *
 * - web-safe links (`http(s):`, `mailto:`) open in the OS default browser via
 *   the runner host;
 * - file links (bare paths, rooted paths, Windows drives, `file://` URIs) are
 *   handed to the surface's `MarkdownLinkContext` policy.
 */
export function MarkdownAnchor({
  href,
  title,
  className,
  children,
}: MarkdownAnchorProps) {
  const runnerHost = use(RunnerHostContext);
  const linkPolicy = use(MarkdownLinkContext);
  const reportIssueAvailable = useDesktopDialogStore(
    (state) => state.reportIssueAvailable,
  );
  const routeLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      // Same-document anchors should keep native browser hash scrolling.
      // Links that leave the current surface are routed explicitly below.
      if (href === undefined) return;

      const classified = classifyHref(href);
      if (classified.kind === "default") return;

      event.preventDefault();
      event.stopPropagation();
      if (classified.kind === "ignore") return;

      if (classified.kind === "file") {
        // `openFileLink` returns `false` when the surface can't resolve the
        // link (path outside the workspace, a directory ref, a torn-down tab).
        // `preventDefault` already swallowed the native navigation, so without
        // feedback that click is a silent no-op - surface a subtle toast. A
        // missing policy (`undefined`) is left silent: the surface simply opts
        // out of file routing.
        const opened = linkPolicy?.openFileLink({
          path: classified.path,
          line: classified.line,
          col: classified.col,
          isDirectory: false,
        });
        if (opened === false) {
          toast(
            "Couldn't open link",
            reportIssueAvailable
              ? {
                  cancel: {
                    label: "Report issue",
                    onClick: () => {
                      const current = useDesktopDialogStore.getState();
                      if (!current.reportIssueAvailable) return;
                      current.openReportIssueWithContext(
                        MARKDOWN_LINK_REPORT_CONTEXT,
                      );
                    },
                  },
                }
              : undefined,
          );
        }
        return;
      }

      if (runnerHost !== null) void runnerHost.openExternalLink(classified.url);
    },
    [href, linkPolicy, reportIssueAvailable, runnerHost],
  );

  return (
    <a href={href} title={title} className={className} onClick={routeLinkClick}>
      {children}
    </a>
  );
}
