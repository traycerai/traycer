import { use, useCallback, type MouseEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useOpenLink } from "@/lib/links/open-link";
import { classifyHref } from "@/markdown/links/classify-href";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { onMiddleClick } from "@/lib/dom/on-middle-click";

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
 * Intercept markdown clicks. Web-safe hrefs go to `useOpenLink`; file hrefs to `MarkdownLinkContext`. A blank href never reaches the DOM.
 */
export function MarkdownAnchor({
  href,
  title,
  className,
  children,
}: MarkdownAnchorProps) {
  const linkPolicy = use(MarkdownLinkContext);
  const openLink = useOpenLink();

  const reportIssueAvailable = useDesktopDialogStore(
    (state) => state.reportIssueAvailable,
  );
  // Empty href is the current document; drop the attribute so click/keyboard
  // cannot reload the renderer.
  const navigableHref =
    href === undefined || href.trim().length === 0 ? undefined : href;
  const routeLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      // Same-document anchors should keep native browser hash scrolling.
      // Links that leave the current surface are routed explicitly below.
      if (navigableHref === undefined) return;

      const classified = classifyHref(navigableHref);
      if (classified.kind === "default") return;

      event.preventDefault();
      event.stopPropagation();
      if (classified.kind === "ignore") return;

      if (classified.kind === "file") {
        // openFileLink false after preventDefault is a silent no-op; toast.
        // undefined policy is opt-out and stays silent.
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

      linkPolicy?.supersedePendingFileLink();
      // Already preventDefaulted. Do not gate on RunnerHost; openLink toasts
      // if the bridge is missing.
      void openLink(classified.url, "markdown", event);
    },
    [navigableHref, linkPolicy, openLink, reportIssueAvailable],
  );

  // Native title is the author-written Markdown link title, not app chrome.
  // A tooltip would restyle it as UI and strip the attribute.
  return (
    <a
      href={navigableHref}
      className={className}
      title={title}
      onClick={routeLinkClick}
      onAuxClick={onMiddleClick(routeLinkClick)}
    >
      {children}
    </a>
  );
}
