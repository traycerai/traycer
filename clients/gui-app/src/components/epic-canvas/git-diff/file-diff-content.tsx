import type { UIEvent } from "react";
import type { GitGetFileDiffResponse } from "@traycer/protocol/host";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import { TruncatedBanner } from "./truncated-banner";

interface FileDiffContentProps {
  readonly diff: GitGetFileDiffResponse;
  readonly mode: "split" | "unified";
  readonly wordWrap: boolean;
  readonly backgrounds: boolean;
  readonly lineNumbers: boolean;
  readonly indicatorStyle: "bars" | "classic" | "none";
  readonly onLoadFull: () => void;
  readonly sizing: "fill" | "content";
  readonly scrollContainerRef:
    ((element: HTMLDivElement | null) => void) | null;
  readonly onScroll: ((event: UIEvent<HTMLDivElement>) => void) | null;
}

/**
 * Live Git diff renderer. Maps the host `git.getFileDiff` response onto the
 * shared `DiffContentPrimitive`, layering the Git-specific truncated banner on
 * top. The cache scope keys on the file path + both OIDs so the
 * parse cache invalidates on file/oid change (ADR-0002).
 */
export function FileDiffContent(props: FileDiffContentProps) {
  const stagedOid = props.diff.stagedOid ?? "null";
  const worktreeOid = props.diff.worktreeOid ?? "null";
  const cacheScope = `${props.diff.filePath}:${stagedOid}:${worktreeOid}`;

  return (
    <DiffContentFrame
      sizing={props.sizing}
      scrollContainerRef={props.scrollContainerRef}
      onScroll={props.onScroll}
      banner={
        props.diff.isTruncated ? (
          <TruncatedBanner
            truncatedAfterBytes={props.diff.truncatedAfterBytes ?? 0}
            onLoadFull={props.onLoadFull}
          />
        ) : null
      }
    >
      <DiffContentPrimitive
        patch={props.diff.patch}
        cacheScope={cacheScope}
        mode={props.mode}
        wordWrap={props.wordWrap}
        backgrounds={props.backgrounds}
        lineNumbers={props.lineNumbers}
        indicatorStyle={props.indicatorStyle}
        fileHeaders={false}
      />
    </DiffContentFrame>
  );
}
