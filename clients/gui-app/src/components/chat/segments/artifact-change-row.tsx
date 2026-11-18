import { useState } from "react";
import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  FileArtifactIcon,
  StaticEpicNodeIcon,
} from "@/components/epic-canvas/epic-node-tab-icon";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import type {
  ArtifactFolderBundle,
  ArtifactFolderMember,
} from "@/lib/chat/artifact-folder-bundles";
import { artifactDiffRenderable } from "@/lib/chat/artifact-diff-renderable";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";
import { useIsLooseFileArtifact } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import type { ArtifactChangeRow as ArtifactChangeRowModel } from "@/stores/composer/chat-store";
import { OpenFullDiffControl } from "./open-full-diff-control";
import { SegmentRow } from "./segment-row";
import { SnapshotHashInlineDiff } from "./snapshot-hash-inline-diff";
import {
  useArtifactRowDisplay,
  type ArtifactRowDisplay,
} from "./use-artifact-row-display";

/**
 * One artifact row inside a per-turn "Changes" group: shows the resolved
 * artifact title (live by id, with the captured fallback) instead of the raw
 * `index.md` path. The title opens the artifact in the canvas; expanding the row
 * lazy-renders the merged diff from the captured snapshot hashes. Mirrors how a
 * file row both opens a tile and expands inline.
 */
export function ArtifactChangeRow(props: { row: ArtifactChangeRowModel }) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  const display = useArtifactRowDisplay({
    artifactId: row.artifactId,
    artifactKind: row.artifactKind,
    fallbackTitle: row.title,
    operation: row.operation,
  });
  const hasDiff = artifactDiffRenderable({
    operation: row.operation,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
  });

  const header = (
    <>
      <ArtifactRowTitle display={display} operation={row.operation} />
      {open && hasDiff ? (
        <OpenFullDiffControl
          filePath={row.filePath}
          beforeHash={row.beforeHash}
          afterHash={row.afterHash}
          title={display.title}
        />
      ) : null}
    </>
  );

  return (
    <SegmentRow
      headerAction={null}
      open={open}
      onOpenChange={setOpen}
      header={header}
      body={open ? <ArtifactRowDiff row={row} hasDiff={hasDiff} /> : null}
      tone={display.isDeleted ? "destructive" : "default"}
      stickyHeader
      expandable={hasDiff}
      headerFindUnitId={null}
      bodyFindUnitId={null}
      className={undefined}
      footer={null}
    />
  );
}

/**
 * One html or canvas artifact's changes in a turn. A loose HTML page is its
 * own single file and reads as any single artifact row; a folder shows the
 * artifact's title and the number of files, expanding to one row per changed
 * file, each of which expands to its own diff.
 */
export function ArtifactBundleChangeRow(props: {
  bundle: ArtifactFolderBundle<ArtifactChangeRowModel>;
}) {
  const { bundle } = props;
  return useIsLooseFileArtifact(bundle.artifactId) ? (
    <ArtifactChangeRow row={bundle.members[0].item} />
  ) : (
    <ArtifactFolderChangeRow bundle={bundle} />
  );
}

function ArtifactFolderChangeRow(props: {
  bundle: ArtifactFolderBundle<ArtifactChangeRowModel>;
}) {
  const { bundle } = props;
  const [open, setOpen] = useState(false);
  const display = useArtifactRowDisplay({
    artifactId: bundle.artifactId,
    artifactKind: bundle.artifactKind,
    fallbackTitle: bundle.title,
    operation: bundle.operation,
  });
  const memberCount = bundle.members.length;

  const header = (
    <>
      <ArtifactRowTitle display={display} operation={bundle.operation} />
      <span className="shrink-0 text-ui-sm text-muted-foreground">
        {memberCount} {memberCount === 1 ? "file" : "files"}
      </span>
    </>
  );

  const body = open ? (
    <div className="flex flex-col gap-1.5">
      {bundle.members.map((member) => (
        <ArtifactBundleMemberRow key={member.item.filePath} member={member} />
      ))}
    </div>
  ) : null;

  return (
    <SegmentRow
      headerAction={null}
      open={open}
      onOpenChange={setOpen}
      header={header}
      body={body}
      tone={display.isDeleted ? "destructive" : "default"}
      stickyHeader={false}
      expandable
      headerFindUnitId={null}
      bodyFindUnitId={null}
      className={undefined}
      footer={null}
    />
  );
}

function ArtifactBundleMemberRow(props: {
  member: ArtifactFolderMember<ArtifactChangeRowModel>;
}) {
  const { item: row, label } = props.member;
  const [open, setOpen] = useState(false);
  const hasDiff = artifactDiffRenderable({
    operation: row.operation,
    beforeHash: row.beforeHash,
    afterHash: row.afterHash,
  });

  const header = (
    <>
      <MaterialFileIcon filename={row.filePath} className="size-3.5 shrink-0" />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        {artifactOperationVerb(row.operation)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <FilePathTooltip content={row.filePath} side="bottom">
        <StartTruncatedText className="min-w-0 flex-1 font-mono text-code-sm text-foreground/85">
          {label}
        </StartTruncatedText>
      </FilePathTooltip>
      {open && hasDiff ? (
        <OpenFullDiffControl
          filePath={row.filePath}
          beforeHash={row.beforeHash}
          afterHash={row.afterHash}
          title={label}
        />
      ) : null}
    </>
  );

  return (
    <SegmentRow
      headerAction={null}
      open={open}
      onOpenChange={setOpen}
      header={header}
      body={open ? <ArtifactRowDiff row={row} hasDiff={hasDiff} /> : null}
      tone={row.operation === "delete" ? "destructive" : "default"}
      stickyHeader
      expandable={hasDiff}
      headerFindUnitId={null}
      bodyFindUnitId={null}
      className={undefined}
      footer={null}
    />
  );
}

function ArtifactRowDiff(props: {
  row: ArtifactChangeRowModel;
  hasDiff: boolean;
}) {
  const { row } = props;
  if (!props.hasDiff) {
    return (
      <div className="text-ui-sm text-muted-foreground">No diff available.</div>
    );
  }
  return (
    <SnapshotHashInlineDiff
      filePath={row.filePath}
      beforeHash={row.beforeHash}
      afterHash={row.afterHash}
      // Keyed by path, not artifact id: the files of one html or canvas
      // artifact share its id and each needs its own cached diff.
      cacheScope={`artifact-group:${row.filePath}`}
    />
  );
}

function ArtifactRowTitle(props: {
  display: ArtifactRowDisplay;
  operation: CheckpointFileOperation;
}) {
  const { display } = props;
  return (
    <>
      <ArtifactKindIcon display={display} />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        {artifactOperationVerb(props.operation)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      {display.canOpen ? (
        // role=button span (not a nested <button>) because SegmentRow already
        // wraps the header in a CollapsibleTrigger button.
        <StartTruncatedText
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            display.openArtifact();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            display.openArtifact();
          }}
          className={cn(
            "min-w-0 flex-1 text-ui-sm text-foreground/85",
            "hover:text-foreground hover:underline underline-offset-2",
            "focus-visible:underline focus-visible:outline-none",
            "cursor-pointer",
          )}
        >
          {display.title}
        </StartTruncatedText>
      ) : (
        <StartTruncatedText
          className={cn(
            "min-w-0 flex-1 text-ui-sm text-foreground/85",
            display.isDeleted && "text-muted-foreground line-through",
          )}
        >
          {display.title}
        </StartTruncatedText>
      )}
    </>
  );
}

function ArtifactKindIcon(props: { display: ArtifactRowDisplay }) {
  const { display } = props;
  return display.displayKind === "file" ? (
    <FileArtifactIcon
      viewer={display.fileViewer}
      className="size-3.5 shrink-0 text-muted-foreground/80"
    />
  ) : (
    <StaticEpicNodeIcon
      type={display.displayKind}
      className="size-3.5 shrink-0 text-muted-foreground/80"
    />
  );
}
