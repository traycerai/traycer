import { useMemo, useState } from "react";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { LivePulse } from "@/components/ui/live-pulse";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { cn } from "@/lib/utils";
import { buildSnapshotUnifiedPatch } from "@/lib/diff/snapshot-diff-patch";
import { useSnapshotDiffQuery } from "@/hooks/snapshots/use-snapshot-diff-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  payloadTruncationNotice,
  usePublishedChatSource,
  usePublishedSnapshotDiff,
  type PayloadExtent,
  type PayloadReadFailure,
  type PublishedChatSource,
} from "@/lib/chats/published-chat-source";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import {
  useChatSnapshotDiffOpener,
  type DiffRowClickHandlers,
} from "@/components/chat/chat-diff-target";
import type {
  FileChangeSegment as FileChangeSegmentModel,
  FileEditReason,
  SegmentEndState,
} from "@/stores/composer/chat-store";
import { FILE_EDIT_REASON_COPY } from "@/lib/chat/file-edit-reason-copy";
import { SegmentCard } from "./segment-card";
import { SegmentRow } from "./segment-row";
import { SegmentEndStateBadge } from "./segment-end-state-badge";

interface FileChangeSegmentProps {
  segment: FileChangeSegmentModel;
  variant: "card" | "row";
  headerFindUnitId: string | null;
  // Seeds the disclosure at mount, once. Open state is local here, so the copy
  // of this row inside the bounded live activity window cannot hand its own
  // over: a click there promotes, and this is how the copy that replaces it
  // knows it was the row asked for.
  initiallyOpen: boolean;
}

export function FileChangeSegment(props: FileChangeSegmentProps) {
  const { segment, variant } = props;
  const { filePath, operation, reason, isStreaming, endState } = segment;
  const [open, setOpen] = useState(props.initiallyOpen);
  // Counts come precomputed on the segment (computed at capture time); no
  // content fetch is needed to render the collapsed header.
  const hasDiff = segment.additions > 0 || segment.deletions > 0;
  const opener = useChatSnapshotDiffOpener();
  // Clicking the file path opens this single edit's snapshot diff tile
  // (single-click = preview, double-click = pinned), mirroring the Git file
  // list. `null` when there is no chat target (isolated render) - the path
  // then renders as plain, non-interactive text.
  const clickHandlers = useMemo<DiffRowClickHandlers | null>(
    () =>
      opener === null
        ? null
        : opener.segment({
            filePath,
            sourceBlockIds: segment.sourceBlockIds,
          }),
    [filePath, opener, segment.sourceBlockIds],
  );

  const header = (
    <FileChangeHeader
      filePath={filePath}
      operation={operation}
      additions={segment.additions}
      deletions={segment.deletions}
      isStreaming={isStreaming}
      endState={endState}
      reason={reason}
      clickHandlers={clickHandlers}
    />
  );

  const body = open ? fileChangeBody(segment, hasDiff, reason) : null;

  if (variant === "row") {
    return (
      <SegmentRow
        headerAction={null}
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        tone="default"
        stickyHeader
        expandable
        headerFindUnitId={props.headerFindUnitId}
        bodyFindUnitId={null}
        className={undefined}
        footer={null}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={setOpen}
      header={header}
      headerAction={null}
      collapsedPreview={null}
      body={body}
      tone="default"
      headerPosition="sticky"
      bodyOverflow="visible"
      expandable
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}

function fileChangeBody(
  segment: FileChangeSegmentModel,
  hasDiff: boolean,
  reason: FileEditReason,
) {
  if (hasDiff) return <FileChangeInlineDiff segment={segment} />;
  return (
    <div className="text-ui-sm text-muted-foreground">
      {FILE_EDIT_REASON_COPY[reason]}
    </div>
  );
}

/**
 * Inline diff for a tool-call file edit, rendered through the same
 * `@pierre/diffs` pipeline as the Git diff tiles (via `DiffContentPrimitive`)
 * so the chat stream and the diff ecosystem look identical. Uses a fixed
 * inline-unified preset suited to the chat column: unified, no file header,
 * no line numbers, full changed-line backgrounds, and a compact change gutter.
 * This intentionally does not follow the global canvas diff viewer preferences.
 *
 * The before/after content is no longer inlined in the chat doc - it is
 * lazy-fetched from the host's snapshot blob store by hash on first expand
 * (this component only mounts when the row is open), then synthesized into a
 * unified patch client-side. While pending, a spinner shows; if the blob can't
 * be served the matching reason copy is shown; and on a published copy, whose
 * fetch crosses the network, a read that FAILED gets a retry instead of that
 * copy - it is not the same fact.
 */
function FileChangeInlineDiff(props: { segment: FileChangeSegmentModel }) {
  const { segment } = props;
  // Hookless dispatcher, the same shape `ChatNodeShell` uses: a live chat must
  // not merely SKIP the cloud read, it must not mount its query observer at
  // all. A transcript can hold dozens of these, and the live path stays exactly
  // the code that shipped - no extra observer, no new provider requirement.
  const published = usePublishedChatSource();
  if (published === null) return <LiveFileChangeInlineDiff segment={segment} />;
  return <PublishedFileChangeInlineDiff segment={segment} source={published} />;
}

function LiveFileChangeInlineDiff(props: { segment: FileChangeSegmentModel }) {
  const query = useSnapshotDiffQuery({
    // The transcript only ever renders inside a chat TILE (`chat-tile.tsx` is
    // the sole mount of `<ChatMessages>`), and the snapshot blobs this row
    // expands were written by that tab's host - which is also the client the
    // PUBLISHED arm beside this one reads off `PublishedChatSource` (D15).
    client: useTabHostClient(),
    beforeHash: props.segment.beforeHash,
    afterHash: props.segment.afterHash,
    enabled: true,
  });
  return (
    <FileChangeDiffView
      segment={props.segment}
      data={query.data}
      isLoading={query.isLoading}
      truncation={null}
      // The local snapshot store either holds the blob or does not; there is no
      // wire to fail, so this arm has nothing to retry.
      failure={null}
    />
  );
}

function PublishedFileChangeInlineDiff(props: {
  segment: FileChangeSegmentModel;
  source: PublishedChatSource;
}) {
  const query = usePublishedSnapshotDiff({
    source: props.source,
    beforeHash: props.segment.beforeHash,
    afterHash: props.segment.afterHash,
    enabled: true,
  });
  return (
    <FileChangeDiffView
      segment={props.segment}
      data={query.data}
      isLoading={query.isLoading}
      truncation={query.truncation}
      failure={query.failure}
    />
  );
}

/** The rendering both sources share; only where `data` came from differs. */
function FileChangeDiffView(props: {
  segment: FileChangeSegmentModel;
  data:
    | {
        readonly beforeContent: string | null;
        readonly afterContent: string | null;
        readonly reason: FileEditReason;
      }
    | undefined;
  isLoading: boolean;
  /**
   * Set when the content is a PREFIX. Always null on the live path, where the
   * snapshot store serves whole blobs; a cloud payload above the reader's
   * preview bound is served truncated, and a diff built from a prefix must not
   * read as the complete set of changes.
   */
  truncation: PayloadExtent | null;
  /**
   * Set when a side's read FAILED. Always null on the live path. Drawn INSTEAD
   * of the reason copy, because "snapshot blob missing" is a verdict about the
   * owner's upload and this is a verdict about the network.
   */
  failure: PayloadReadFailure | null;
}) {
  const { segment, data, isLoading } = props;
  const patch = useMemo(() => {
    if (data === undefined || data.reason !== "snapshot") {
      return null;
    }
    return buildSnapshotUnifiedPatch({
      filePath: segment.filePath,
      beforeContent: data.beforeContent,
      afterContent: data.afterContent,
      ignoreWhitespace: false,
    });
  }, [data, segment.filePath]);

  // isLoading (not isPending): a disabled query (e.g. both hashes null) keeps
  // isPending true forever; only show the spinner while genuinely fetching, and
  // otherwise fall through to the reason copy.
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading diff…
      </div>
    );
  }
  // Before the reason copy: a failed read has no `data`, so falling through
  // would print "Skipped - snapshot blob missing." for content the next request
  // may well return.
  if (props.failure !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-ui-sm text-muted-foreground">
        <span>Couldn&apos;t load this diff.</span>
        <button
          type="button"
          onClick={props.failure.retry}
          data-testid="file-change-diff-retry"
          className={cn(
            "underline underline-offset-2",
            "hover:text-foreground focus-visible:outline-none focus-visible:text-foreground",
          )}
        >
          Retry
        </button>
      </div>
    );
  }
  if (patch === null) {
    const reason: FileEditReason = data?.reason ?? "blob_missing";
    return (
      <div className="text-ui-sm text-muted-foreground">
        {FILE_EDIT_REASON_COPY[reason]}
      </div>
    );
  }
  return (
    <DiffContentFrame
      sizing="content"
      // A prefix must not read as the whole file. The frame already has a slot
      // for exactly this kind of statement, so the notice sits with the diff
      // rather than in a branch that forks the rendering.
      banner={
        props.truncation === null ? null : (
          <p
            className="px-2 py-1 text-ui-xs italic text-muted-foreground"
            data-testid="file-change-truncated-notice"
          >
            {payloadTruncationNotice(props.truncation)}
          </p>
        )
      }
      scrollContainerRef={null}
      onScroll={null}
      fileIdentity={null}
    >
      <DiffContentPrimitive
        patch={patch}
        cacheScope={`inline:${segment.id}`}
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers={false}
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
      />
    </DiffContentFrame>
  );
}

/**
 * Human verb for a file-change `operation`, so the row reads `Edit · path`
 * (mirroring how a tool row reads `Read · path`) instead of a bare path.
 * `operation` is an open string across harnesses: Claude emits
 * `edit`/`ambiguous`(Write)/`delete`; OpenCode emits `patch`.
 */
function fileChangeVerb(operation: string): string {
  switch (operation) {
    case "delete":
      return "Delete";
    case "create":
      return "Create";
    case "ambiguous":
      return "Write";
    default:
      return "Edit";
  }
}

/** Status badge (mirrors the tool segment's ERROR badge) shown in place of the
 * +/- counts when an edit never produced a change. */
const FILE_EDIT_STATUS_LABEL: Partial<Record<FileEditReason, string>> = {
  denied: "denied",
  capture_failed: "failed",
};

interface FileChangeHeaderProps {
  filePath: string;
  operation: string;
  additions: number;
  deletions: number;
  isStreaming: boolean;
  // Terminal outcome when the turn ended mid-edit (else null): drives a neutral
  // "stopped"/"superseded" badge. Always null for committed/accumulated diffs.
  endState: SegmentEndState;
  reason: FileEditReason;
  // Single-click opens a preview diff tile; double-click pins it. `null`
  // renders the path as plain, non-interactive text.
  clickHandlers: DiffRowClickHandlers | null;
}

export function FileChangeHeader(props: FileChangeHeaderProps) {
  const {
    filePath,
    operation,
    additions,
    deletions,
    isStreaming,
    endState,
    reason,
    clickHandlers,
  } = props;
  const statusLabel = FILE_EDIT_STATUS_LABEL[reason] ?? null;
  return (
    <>
      <MaterialFileIcon filename={filePath} className="size-4 shrink-0" />
      <span className="shrink-0 font-mono text-code-sm font-medium text-foreground/85">
        {fileChangeVerb(operation)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      {clickHandlers === null ? (
        <FilePathTooltip content={filePath} side="bottom">
          <StartTruncatedText className="min-w-0 flex-1 font-mono text-code-sm text-foreground/85">
            {filePath}
          </StartTruncatedText>
        </FilePathTooltip>
      ) : (
        // Rendered as a span (not button) because the surrounding
        // SegmentCard/SegmentRow already wraps the entire header in a Radix
        // CollapsibleTrigger <button>; nesting buttons is invalid HTML
        // and triggers a hydration error. role=button + keydown keep
        // keyboard activation so the path is still openable.
        <StartTruncatedText
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            clickHandlers.onClick();
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            clickHandlers.onDoubleClick();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            clickHandlers.onClick();
          }}
          className={cn(
            "min-w-0 flex-1 font-mono text-code-sm text-foreground/85",
            "hover:text-foreground hover:underline underline-offset-2",
            "focus-visible:outline-none focus-visible:underline",
            "cursor-pointer",
          )}
        >
          {filePath}
        </StartTruncatedText>
      )}
      {statusLabel !== null ? (
        <span className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 text-overline font-medium uppercase text-destructive">
          {statusLabel}
        </span>
      ) : (
        <span className="@max-[28rem]:hidden flex shrink-0 items-center gap-1.5 font-mono text-code-xs">
          {additions > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              +{additions}
            </span>
          ) : null}
          {deletions > 0 ? (
            <span className="text-destructive">−{deletions}</span>
          ) : null}
        </span>
      )}
      {isStreaming ? (
        <LivePulse
          size="xs"
          tone="active"
          ariaLabel="File change in progress"
          className={undefined}
        />
      ) : null}
      <SegmentEndStateBadge endState={endState} stopped={false} />
    </>
  );
}
