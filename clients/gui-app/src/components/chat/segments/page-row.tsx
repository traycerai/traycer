import { useCallback, useState, type ReactNode } from "react";
import { Download, FileCode, Globe, Layers, Maximize2 } from "lucide-react";
import type {
  ToolCallPageStamp,
  ToolInputDetail,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  parseEpicFileRef,
  type EpicFileRef,
} from "@traycer/protocol/persistence/epic/files";
import { useChatAttachmentScope } from "@/components/chat/chat-attachment-scope-context";
import { useScrollToChatPage } from "@/components/chat/chat-scroll-to-block";
import { HtmlViewer } from "@/components/files/viewers/html-viewer";
import { LivePulse } from "@/components/ui/live-pulse";
import { Shimmer } from "@/components/ui/shimmer";
import { BlockFloatingToolbar } from "@/editor-core/nodes/shared/block-floating-toolbar";
import { ToolbarButton } from "@/editor-core/toolbar/toolbar-button";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  epicFileName,
  useEpicFileDownload,
  useEpicFileOpenInBrowser,
} from "@/hooks/files/use-epic-file-mutations";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import { LiveElapsed } from "./segment-elapsed";
import { TouchActionsSheet } from "./touch-actions-sheet";

const SHOW_PAGE_TOOL_LABEL = "traycer_show_page";

export interface PageRowProps {
  readonly id: string;
  readonly page: ToolCallPageStamp | null;
  readonly inputSummary: string | null;
  readonly inputDetail: ToolInputDetail | null;
  readonly error: string | null;
  readonly isStreaming: boolean;
  readonly stopped: boolean;
  readonly startedAt: number;
  /** What a call with no page to show renders: the ordinary tool row. */
  readonly fallback: ReactNode;
}

/**
 * A `traycer_show_page` call, rendered as the page it showed, at the point in
 * the reply where the agent showed it (D05). Borderless: the page paints the
 * transcript surface itself, so it reads as part of the reply (D07).
 *
 * - writing: "Building page: <title>" (PageStates 1, D06);
 * - failed: the call's error, which the agent saw too (PageStates 6);
 * - shown: the page, with its hover bar or touch actions (Main, MobileChat).
 *
 * A call that ended any other way (stopped, or from a host that predates the
 * stamp) is an ordinary tool row.
 */
export function PageRow(props: PageRowProps): ReactNode {
  const scope = useChatAttachmentScope();
  if (props.page !== null && scope !== null) {
    return (
      <ShownPage
        page={props.page}
        address={{
          epicId: scope.epicId,
          path: props.page.path,
          sha256: props.page.sha256,
          via: { chatId: scope.chatId, blockId: props.id },
        }}
        hostId={scope.hostId}
      />
    );
  }
  if (props.page === null && props.isStreaming) {
    return (
      <BuildingPage
        title={pageInputTitle(props.inputDetail, props.inputSummary)}
        startedAt={props.startedAt}
      />
    );
  }
  if (
    props.page === null &&
    !props.stopped &&
    props.error !== null &&
    props.error.length > 0
  ) {
    return <FailedPage error={props.error} />;
  }
  return props.fallback;
}

/** The title the agent passed, while the page has no stamp yet. */
function pageInputTitle(
  detail: ToolInputDetail | null,
  summary: string | null,
): string | null {
  if (detail?.kind === "fields") {
    const title = detail.entries.find((entry) => entry.key === "title");
    if (title !== undefined && title.value.trim().length > 0) {
      return title.value;
    }
  }
  return summary;
}

function BuildingPage(props: {
  readonly title: string | null;
  readonly startedAt: number;
}) {
  const label =
    props.title === null ? "Building page" : `Building page: ${props.title}`;
  return (
    <div
      data-find-skip=""
      data-testid="page-row-building"
      className="flex items-center gap-2 p-1 text-ui-sm text-muted-foreground"
    >
      <FileCode className="size-3.5 shrink-0 text-foreground" aria-hidden />
      <Shimmer
        as="span"
        className="min-w-0 truncate font-medium [--shimmer-text-color:var(--color-muted-foreground)]"
      >
        {label}
      </Shimmer>
      <LiveElapsed startedAt={props.startedAt} />
      <LivePulse
        size="xs"
        tone="active"
        ariaLabel="Building page"
        className={undefined}
      />
    </div>
  );
}

function FailedPage(props: { readonly error: string }) {
  return (
    <div
      data-find-skip=""
      data-testid="page-row-failed"
      className="flex items-center gap-2 p-1 text-ui-sm text-destructive"
    >
      <FileCode className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 font-mono text-code-sm font-medium">
        {SHOW_PAGE_TOOL_LABEL}
      </span>
      <span aria-hidden className="shrink-0 opacity-40">
        ·
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-code-sm">
        {props.error}
      </span>
      <span className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 text-overline font-medium uppercase">
        error
      </span>
    </div>
  );
}

/** The stamped height nearest the row's width, else the agent's own. */
function initialPageHeight(
  page: ToolCallPageStamp,
  width: number | null,
): number {
  if (width === null) return page.height;
  let best: { readonly width: number; readonly height: number } | null = null;
  for (const entry of page.heights) {
    if (entry.height <= 0) continue;
    if (
      best === null ||
      Math.abs(entry.width - width) < Math.abs(best.width - width)
    ) {
      best = entry;
    }
  }
  return best?.height ?? page.height;
}

interface PageActions {
  readonly expand: () => void;
  readonly openInBrowser: () => void;
  readonly openInBrowserPending: boolean;
  readonly download: () => void;
  readonly downloadPending: boolean;
}

function usePageActions(
  page: ToolCallPageStamp,
  address: EpicFileAddress,
  hostId: string,
): PageActions {
  const { openTile } = useEpicTileNavigation();
  const openInBrowser = useEpicFileOpenInBrowser(address);
  const download = useEpicFileDownload(hostId, address);
  const track = (action: "expand" | "download" | "open_browser"): void => {
    Analytics.getInstance().track(AnalyticsEvent.PageAction, { action });
  };
  return {
    expand: () => {
      track("expand");
      openTile(
        tileIntent(
          makeEpicFileTileRef({
            path: page.path,
            sha256: page.sha256,
            name: page.title,
            hostId,
            via: address.via,
          }),
          { epicId: address.epicId },
          "explicit",
          "direct_ui",
        ),
      );
    },
    openInBrowser: () => {
      track("open_browser");
      openInBrowser.mutate();
    },
    openInBrowserPending: openInBrowser.isPending,
    download: () => {
      track("download");
      download.mutation.mutate();
    },
    downloadPending: download.mutation.isPending,
  };
}

function ShownPage(props: {
  readonly page: ToolCallPageStamp;
  readonly address: EpicFileAddress;
  readonly hostId: string;
}) {
  const { page, address, hostId } = props;
  const actions = usePageActions(page, address, hostId);
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (node !== null) setWidth(node.offsetWidth);
  }, []);

  return (
    <figure
      aria-label={`Page: ${page.title}`}
      data-testid="page-row"
      data-find-skip=""
      data-quote-exclude=""
      className="m-0 flex flex-col"
    >
      {page.derivedFrom === null ? null : (
        <DerivedFromCaption
          derivedFrom={page.derivedFrom}
          epicId={address.epicId}
          hostId={hostId}
        />
      )}
      <div ref={measure} className="tc-node-page relative w-full">
        <BlockFloatingToolbar label="Page actions">
          <ToolbarButton
            icon={<Maximize2 className="size-4" aria-hidden />}
            label="Expand"
            active={false}
            onClick={actions.expand}
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Globe className="size-4" aria-hidden />}
            label="Open in browser"
            active={false}
            disabled={actions.openInBrowserPending}
            onClick={actions.openInBrowser}
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Download className="size-4" aria-hidden />}
            label="Download HTML"
            active={false}
            disabled={actions.downloadPending}
            onClick={actions.download}
            className="tc-editor-toolbar-button"
          />
        </BlockFloatingToolbar>
        <PageTouchActions title={page.title} actions={actions} />
        {width === null ? null : (
          <HtmlViewer
            hostId={hostId}
            address={address}
            title={page.title}
            initialHeight={initialPageHeight(page, width)}
            onOpenInBrowser={actions.openInBrowser}
            openInBrowserPending={actions.openInBrowserPending}
          />
        )}
      </div>
    </figure>
  );
}

/**
 * PageStates 4: an edited page links back to the one it replaced (D09) - its
 * row when this transcript has it loaded, else that version in the epic-file
 * tile. A reference that does not parse is plain text.
 */
function DerivedFromCaption(props: {
  readonly derivedFrom: string;
  readonly epicId: string;
  readonly hostId: string;
}) {
  const scrollToPage = useScrollToChatPage();
  const { openTile } = useEpicTileNavigation();
  const earlier = parseEpicFileRef(props.derivedFrom);
  const openEarlier = (ref: EpicFileRef): void => {
    if (scrollToPage?.(props.derivedFrom) === true) return;
    openTile(
      tileIntent(
        makeEpicFileTileRef({
          path: ref.path,
          sha256: ref.sha256,
          name: epicFileName(ref.path),
          hostId: props.hostId,
          // Not opened from a row: the host decides its policy without one.
          via: null,
        }),
        { epicId: props.epicId },
        "explicit",
        "direct_ui",
      ),
    );
  };
  return (
    <figcaption className="mb-2 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
      <Layers className="size-3.5 shrink-0" aria-hidden />
      <span>
        Updated from{" "}
        {earlier === null ? (
          "an earlier page"
        ) : (
          <button
            type="button"
            className="text-foreground underline underline-offset-3"
            onClick={() => openEarlier(earlier)}
          >
            an earlier page
          </button>
        )}
      </span>
    </figcaption>
  );
}

function PageTouchActions(props: {
  readonly title: string;
  readonly actions: PageActions;
}) {
  const { actions } = props;
  return (
    <TouchActionsSheet
      triggerLabel="Page actions"
      icon={
        <FileCode
          className="size-4 shrink-0 text-[var(--term-ansi-yellow)]"
          aria-hidden
        />
      }
      title={props.title}
      description="Page · shared with the task"
      testId="page-actions-sheet"
      actions={[
        {
          icon: <Maximize2 aria-hidden />,
          label: "Open full screen",
          disabled: false,
          onSelect: actions.expand,
          navigates: true,
        },
        {
          icon: <Globe aria-hidden />,
          label: "Open in browser",
          disabled: actions.openInBrowserPending,
          onSelect: actions.openInBrowser,
          navigates: false,
        },
        {
          icon: <Download aria-hidden />,
          label: "Save HTML file",
          disabled: actions.downloadPending,
          onSelect: actions.download,
          navigates: false,
        },
      ]}
    />
  );
}
