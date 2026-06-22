import { useMemo } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { useSnapshotDiffQuery } from "@/hooks/snapshots/use-snapshot-diff-query";
import { FILE_EDIT_REASON_COPY } from "@/lib/chat/file-edit-reason-copy";
import { buildSnapshotUnifiedPatch } from "@/lib/diff/snapshot-diff-patch";

/**
 * Inline merged diff rendered straight from a pair of snapshot hashes, reusing
 * the same `@pierre/diffs` pipeline as the file-change rows. Unlike
 * `FileChangeInlineDiff` (which keys off a `file_change` segment's
 * `sourceBlockIds`), this takes the before/after hashes directly - the shape
 * artifacts carry (they have no `file_change` block). Mounts only when expanded,
 * so the (common) collapsed case fetches nothing. `create` shows the file as all
 * additions (`beforeHash` null), `delete` as all deletions (`afterHash` null).
 *
 * Pure diff content with no internal scroll/cap: it grows to its full height and
 * scrolls with the chat, while the card / row's sticky header keeps the title +
 * "open full diff" control pinned. The full-diff affordance lives in that header
 * (`OpenFullDiffControl`), not here.
 */
export function SnapshotHashInlineDiff(props: {
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly cacheScope: string;
}) {
  const query = useSnapshotDiffQuery({
    beforeHash: props.beforeHash,
    afterHash: props.afterHash,
    enabled: true,
  });

  const patch = useMemo(() => {
    if (query.data === undefined || query.data.reason !== "snapshot") {
      return null;
    }
    return buildSnapshotUnifiedPatch({
      filePath: props.filePath,
      beforeContent: query.data.beforeContent,
      afterContent: query.data.afterContent,
      ignoreWhitespace: false,
    });
  }, [query.data, props.filePath]);

  if (query.isLoading) {
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
  if (patch === null) {
    const reason = query.data?.reason ?? "blob_missing";
    return (
      <div className="text-ui-sm text-muted-foreground">
        {FILE_EDIT_REASON_COPY[reason]}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <DiffContentFrame
        sizing="content"
        banner={null}
        scrollContainerRef={null}
        onScroll={null}
      >
        <DiffContentPrimitive
          patch={patch}
          cacheScope={props.cacheScope}
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers={false}
          indicatorStyle="bars"
          fileHeaders={false}
        />
      </DiffContentFrame>
    </div>
  );
}
