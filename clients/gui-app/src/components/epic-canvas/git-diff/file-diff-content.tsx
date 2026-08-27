import type { ComponentProps, ReactNode, UIEvent } from "react";
import type { GitGetFileDiffResponse } from "@traycer/protocol/host";
import {
  DiffContentFrame,
  DiffContentPrimitive,
  type DiffContentFrameFileIdentity,
} from "@/components/diff/diff-content-primitive";
import { TruncatedBanner } from "./truncated-banner";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";

interface FileDiffContentProps {
  readonly diff: GitGetFileDiffResponse;
  readonly fileIdentity: DiffContentFrameFileIdentity | null;
  /** Zero-byte file - see `DiffContentPrimitiveProps.isEmptyFile`. */
  readonly isEmptyFile: boolean;
  readonly mode: "split" | "unified";
  readonly wordWrap: boolean;
  readonly backgrounds: boolean;
  readonly lineNumbers: boolean;
  readonly indicatorStyle: "bars" | "classic" | "none";
  readonly onLoadFull: () => void;
  readonly sizing: "fill" | "content";
  readonly scrollContainerRef:
    | ((element: HTMLDivElement | null) => void)
    | null;
  readonly onScroll: ((event: UIEvent<HTMLDivElement>) => void) | null;
  readonly editStatus?: ReactNode;
  readonly editAdapter?: DiffClickToEditAdapter;
  readonly editSession?: NonNullable<
    ComponentProps<typeof DiffContentPrimitive>["editSession"]
  >;
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
    <>
      {props.editStatus}
      <DiffContentFrame
        sizing={props.sizing}
        scrollContainerRef={props.scrollContainerRef}
        onScroll={props.onScroll}
        onKeyDownCapture={props.editAdapter?.onKeyDownCapture}
        onPointerDownCapture={props.editAdapter?.onPointerDownCapture}
        editorBoundary={props.editSession !== undefined}
        fileIdentity={props.fileIdentity}
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
          editAdapter={props.editAdapter}
          editSession={props.editSession}
          isEmptyFile={props.isEmptyFile}
        />
      </DiffContentFrame>
    </>
  );
}
