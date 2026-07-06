import type { ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  buildGitFileRowMetadata,
  type GitFileRowMetadata,
} from "@/lib/git/panel-file-rendering";
import { WorkspaceFileIcon } from "@/components/epic-canvas/workspace-file/workspace-file-icons";
import { Badge } from "@/components/ui/badge";
import {
  splitPathMatchRanges,
  type HighlightRange,
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
  readonly nested: boolean;
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

interface FileNameParts {
  readonly stem: string;
  readonly extension: string | null;
}

function splitFileNameExtension(fileName: string): FileNameParts {
  const extensionStart = fileName.lastIndexOf(".");
  if (extensionStart <= 0 || extensionStart === fileName.length - 1) {
    return { stem: fileName, extension: null };
  }
  return {
    stem: fileName.slice(0, extensionStart),
    extension: fileName.slice(extensionStart),
  };
}

function rangesForTextSlice(
  ranges: HighlightRanges,
  sliceStart: number,
  sliceEndExclusive: number,
): HighlightRanges {
  return ranges.flatMap((range) => {
    const [rangeStart, rangeEnd] = range;
    const clippedStart = Math.max(rangeStart, sliceStart);
    const clippedEnd = Math.min(rangeEnd, sliceEndExclusive - 1);
    if (clippedStart > clippedEnd) return [];
    const shifted: HighlightRange = [
      clippedStart - sliceStart,
      clippedEnd - sliceStart,
    ];
    return [shifted];
  });
}

function MiddleTruncatedFileName(props: {
  readonly fileName: string;
  readonly ranges: HighlightRanges;
  readonly className: string;
}): ReactNode {
  const parts = splitFileNameExtension(props.fileName);
  if (parts.extension === null) {
    return (
      <span className={cn("min-w-0 truncate font-normal", props.className)}>
        <HighlightedText text={props.fileName} ranges={props.ranges} />
      </span>
    );
  }
  const stemRanges = rangesForTextSlice(props.ranges, 0, parts.stem.length);
  const extensionRanges = rangesForTextSlice(
    props.ranges,
    parts.stem.length,
    props.fileName.length,
  );
  return (
    <span
      className={cn("flex min-w-0 items-baseline font-normal", props.className)}
    >
      <span className="min-w-0 truncate">
        <HighlightedText text={parts.stem} ranges={stemRanges} />
      </span>
      <span className="shrink-0">
        <HighlightedText text={parts.extension} ranges={extensionRanges} />
      </span>
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
      <MiddleTruncatedFileName
        fileName={metadata.fileName}
        ranges={fileNameRanges}
        className={hasDirectory ? "shrink" : "flex-1"}
      />
      {hasDirectory ? (
        <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
          <HighlightedText
            text={metadata.directoryName}
            ranges={directoryRanges}
          />
        </span>
      ) : null}
      {props.trailing}
      <RowStats
        file={props.file}
        className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded bg-background/95 px-1 py-0.5 shadow-sm group-hover:flex group-focus-visible:flex"
      />
    </>
  );
}

function gitChangedFileRowClassName(args: {
  readonly isPanel: boolean;
  readonly nested: boolean;
  readonly isConflict: boolean;
  readonly active: boolean;
  readonly className: string | undefined;
}): string {
  return cn(
    "group relative flex w-full items-center text-left text-ui-sm",
    args.isPanel && args.nested && "min-h-6 gap-1.5 py-0.5 pl-10 pr-3",
    args.isPanel && !args.nested && "min-h-6 gap-1.5 px-3 py-0.5",
    !args.isPanel && "min-h-7 gap-2 px-2 py-1",
    args.isConflict &&
      (args.nested
        ? "border-l-2 border-l-destructive pl-9"
        : "border-l-2 border-l-destructive pl-2"),
    args.active && "bg-accent text-accent-foreground",
    args.className,
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

  const rowClassName = gitChangedFileRowClassName({
    isPanel,
    nested: props.nested,
    isConflict: metadata.isConflict,
    active: props.active,
    className: props.className,
  });

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
