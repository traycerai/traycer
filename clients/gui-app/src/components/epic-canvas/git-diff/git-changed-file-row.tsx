import type { ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  buildGitFileRowMetadata,
  type GitFileRowMetadata,
} from "@/lib/git/panel-file-rendering";
import { WorkspaceFileIcon } from "@/components/epic-canvas/workspace-file/workspace-file-icons";
import { Badge } from "@/components/ui/badge";
import {
  TRUNCATE_START_INNER_STYLE,
  TRUNCATE_START_STYLE,
} from "@/lib/truncate-start-style";
import {
  splitPathMatchRanges,
  type HighlightRanges,
} from "@/lib/git/path-highlight";
import { cn } from "@/lib/utils";
import { GitStatusBadge } from "./git-status-badge";
import { HighlightedText } from "./highlighted-text";

export type GitChangedFileRowDensity = "panel" | "tile";

export interface GitChangedFileRowProps {
  readonly file: GitChangedFile;
  readonly density: GitChangedFileRowDensity;
  readonly active: boolean;
  readonly leading: ReactNode | null;
  readonly trailing: ReactNode | null;
  /** Filter match ranges into `file.path`; empty when no filter is active. */
  readonly pathRanges: HighlightRanges;
  readonly onClick: (() => void) | null;
  readonly onDoubleClick: (() => void) | undefined;
  readonly ariaExpanded: boolean | undefined;
  readonly className: string | undefined;
}

interface RowStatsProps {
  readonly file: GitChangedFile;
  readonly className: string | undefined;
}

function RowStats(props: RowStatsProps): ReactNode {
  return (
    <span className={cn("shrink-0 items-center gap-1", props.className)}>
      <span className="shrink-0 text-ui-xs font-medium tabular-nums text-success">
        +{props.file.insertions}
      </span>
      <span className="shrink-0 text-ui-xs font-medium tabular-nums text-destructive">
        -{props.file.deletions}
      </span>
      {props.file.isBinary ? (
        <Badge variant="outline" className="shrink-0">
          bin
        </Badge>
      ) : null}
    </span>
  );
}

function PanelRowContent(props: {
  readonly file: GitChangedFile;
  readonly metadata: GitFileRowMetadata;
  readonly pathRanges: HighlightRanges;
  readonly trailing: ReactNode | null;
}): ReactNode {
  const { metadata } = props;
  const hasDirectory = metadata.directoryName.length > 0;
  const { fileNameRanges, directoryRanges } = splitPathMatchRanges(
    props.file.path,
    metadata.fileName,
    metadata.directoryName,
    props.pathRanges,
  );
  return (
    <>
      <GitStatusBadge
        letter={metadata.statusLetter}
        tone={metadata.statusTone}
        label={metadata.statusLabel}
        withNativeTitle={false}
      />
      <WorkspaceFileIcon fileName={metadata.fileName} className="size-3.5" />
      <span
        className={cn(
          "min-w-0 truncate font-normal",
          hasDirectory ? "shrink" : "flex-1",
        )}
      >
        <HighlightedText text={metadata.fileName} ranges={fileNameRanges} />
      </span>
      {hasDirectory ? (
        // Left-ellipsis so the deepest (most distinguishing) directory
        // segments survive width pressure; the filename keeps priority
        // because this span's flex basis is 0 - it only ever consumes
        // leftover row width.
        <span
          className="min-w-0 flex-1 text-ui-xs text-muted-foreground"
          style={TRUNCATE_START_STYLE}
        >
          <span style={TRUNCATE_START_INNER_STYLE}>
            <HighlightedText
              text={metadata.directoryName}
              ranges={directoryRanges}
            />
          </span>
        </span>
      ) : null}
      {props.trailing}
      <RowStats
        file={props.file}
        className="pointer-events-none absolute right-3 top-1/2 z-10 hidden -translate-y-1/2 rounded bg-background/95 px-1 py-0.5 shadow-sm group-hover:flex group-focus-visible:flex"
      />
    </>
  );
}

function TileRowContent(props: {
  readonly file: GitChangedFile;
  readonly metadata: GitFileRowMetadata;
  readonly leading: ReactNode | null;
  readonly trailing: ReactNode | null;
}): ReactNode {
  const { metadata } = props;
  return (
    <>
      {props.leading}
      <GitStatusBadge
        letter={metadata.statusLetter}
        tone={metadata.statusTone}
        label={metadata.statusLabel}
        withNativeTitle
      />
      <WorkspaceFileIcon fileName={metadata.fileName} className="size-3.5" />
      <span className="min-w-0 truncate font-mono text-ui-sm">
        {metadata.fileName}
      </span>
      {metadata.previousFileName ? (
        <span className="truncate text-ui-xs text-muted-foreground">
          from {metadata.previousFileName}
        </span>
      ) : null}
      {metadata.directoryName.length > 0 ? (
        <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
          {metadata.directoryName}
        </span>
      ) : null}
      <span aria-hidden className="ml-auto" />
      <RowStats file={props.file} className="flex" />
      {props.trailing}
    </>
  );
}

export function GitChangedFileRow(props: GitChangedFileRowProps): ReactNode {
  const metadata = buildGitFileRowMetadata(props.file);
  const isPanel = props.density === "panel";

  const content = isPanel ? (
    <PanelRowContent
      file={props.file}
      metadata={metadata}
      pathRanges={props.pathRanges}
      trailing={props.trailing}
    />
  ) : (
    <TileRowContent
      file={props.file}
      metadata={metadata}
      leading={props.leading}
      trailing={props.trailing}
    />
  );

  const rowClassName = cn(
    "group relative flex w-full items-center text-left text-ui-sm",
    isPanel ? "min-h-6 gap-1.5 px-3 py-0.5" : "min-h-7 gap-2 px-2 py-1",
    metadata.isConflict && "border-l-2 border-l-destructive pl-2",
    props.active && "bg-accent text-accent-foreground",
    props.className,
  );

  const baseAriaLabel = metadata.previousFileName
    ? `${metadata.statusLabel} ${metadata.fileName} (renamed from ${metadata.previousFileName})`
    : `${metadata.statusLabel} ${metadata.fileName}`;
  const ariaLabel =
    isPanel && metadata.directoryName.length > 0
      ? `${baseAriaLabel} in ${metadata.directoryName}`
      : baseAriaLabel;

  if (props.onClick === null) {
    return <div className={rowClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      className={cn(
        rowClassName,
        "transition-colors",
        props.active ? "hover:bg-accent" : "hover:bg-accent/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
      title={isPanel ? undefined : props.file.path}
      aria-label={ariaLabel}
      aria-expanded={props.ariaExpanded}
      aria-current={props.active ? true : undefined}
    >
      {content}
    </button>
  );
}
