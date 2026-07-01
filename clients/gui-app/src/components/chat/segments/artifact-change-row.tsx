import { useState } from "react";
import { StaticEpicNodeIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { artifactDiffRenderable } from "@/lib/chat/artifact-diff-renderable";
import { artifactOperationVerb } from "@/lib/chat/artifact-operation-verb";
import { cn } from "@/lib/utils";
import type { ArtifactChangeRow as ArtifactChangeRowModel } from "@/stores/composer/chat-store";
import { OpenFullDiffControl } from "./open-full-diff-control";
import { SegmentRow } from "./segment-row";
import { SnapshotHashInlineDiff } from "./snapshot-hash-inline-diff";
import { useArtifactRowDisplay } from "./use-artifact-row-display";

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
      <StaticEpicNodeIcon
        type={display.displayKind}
        className="size-3.5 shrink-0 text-muted-foreground/80"
      />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        {artifactOperationVerb(row.operation)}
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

  const renderBody = () =>
    hasDiff ? (
      <SnapshotHashInlineDiff
        filePath={row.filePath}
        beforeHash={row.beforeHash}
        afterHash={row.afterHash}
        cacheScope={`artifact-group:${row.artifactId ?? row.filePath}`}
      />
    ) : (
      <div className="text-ui-sm text-muted-foreground">No diff available.</div>
    );
  const body = open ? renderBody() : null;

  return (
    <SegmentRow
      open={open}
      onOpenChange={setOpen}
      header={header}
      body={body}
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
