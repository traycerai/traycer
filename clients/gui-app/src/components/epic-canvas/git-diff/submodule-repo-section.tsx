import { useCallback, useMemo, type ReactNode } from "react";
import { TriangleAlert, Info } from "lucide-react";
import type { CommitAheadFile, GitChangedFile } from "@traycer/protocol/host";
import type { SubmoduleRepoView } from "@/lib/git/git-repo-composition";
import { splitGitChangedFiles } from "@/lib/git/panel-file-rendering";
import {
  gitBundleGroupLabel,
  makeGitAheadFileDiffTile,
  makeGitFileDiffTile,
} from "@/lib/git/git-diff-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { cn } from "@/lib/utils";
import { SubmoduleFileRow } from "./submodule-file-row";

/** Group heading shared by the ahead group and the submodule's stage groups. */
function GroupHeading(props: {
  readonly title: string;
  readonly count: number | null;
}): ReactNode {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
      <span>{props.title}</span>
      {props.count !== null ? (
        <span className="tabular-nums text-muted-foreground/70">
          {props.count}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The non-ahead relation buckets, rendered as a summary banner with no
 * relation-derived file group. `needs-attention` (unknown) reads as a local
 * limitation via the warning tone + "not comparable locally" detail;
 * `checkout-differs` (behind / diverged / equal-with-WT) is neutral/info.
 */
function RelationBanner(props: {
  readonly tone: "info" | "attention";
  readonly heading: string;
  readonly detail: string;
}): ReactNode {
  return (
    <div
      className={cn(
        "mx-3 my-1 flex items-start gap-2 rounded-md px-2 py-1.5 text-ui-xs",
        props.tone === "attention"
          ? "bg-warning/10 text-warning"
          : "bg-muted/40 text-muted-foreground",
      )}
      role="note"
    >
      {props.tone === "attention" ? (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <div className="min-w-0">
        <div className="font-medium">{props.heading}</div>
        <div className="text-muted-foreground">{props.detail}</div>
      </div>
    </div>
  );
}

/**
 * A submodule working-tree / index file row. Opens an ordinary `getFileDiff`
 * routed to the submodule's own `repoRoot` (so the host diffs inside the
 * submodule, and the cache/tile identity can't collide with the parent's).
 */
function SubmoduleWtFileRow(props: {
  readonly hostId: string;
  readonly viewTabId: string;
  readonly repoRoot: string;
  readonly file: GitChangedFile;
}): ReactNode {
  const openPreview = useEpicCanvasStore((s) => s.openTilePreviewInTab);
  const openPinned = useEpicCanvasStore((s) => s.openTileInTab);
  const tile = useMemo(
    () =>
      makeGitFileDiffTile({
        hostId: props.hostId,
        runningDir: props.repoRoot,
        filePath: props.file.path,
        stage: props.file.stage,
      }),
    [props.hostId, props.repoRoot, props.file.path, props.file.stage],
  );
  const onClick = useCallback(
    () => openPreview(props.viewTabId, tile),
    [openPreview, props.viewTabId, tile],
  );
  const onDoubleClick = useCallback(
    () => openPinned(props.viewTabId, tile),
    [openPinned, props.viewTabId, tile],
  );
  return (
    <SubmoduleFileRow
      file={props.file}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    />
  );
}

/**
 * A "committed changes not recorded by parent" (ahead-of-pin) file row. Opens an
 * `ahead-file` tile that carries only the identity (`repoRoot` + parent worktree
 * + path); the tile re-derives the pin from fresh v1.1 metadata at fetch time
 * (never from persisted state) and issues `getFileDiff({ compareFromSha })`.
 */
function SubmoduleAheadFileRow(props: {
  readonly hostId: string;
  readonly viewTabId: string;
  readonly repoRoot: string;
  readonly parentRunningDir: string;
  readonly file: CommitAheadFile;
}): ReactNode {
  const openPreview = useEpicCanvasStore((s) => s.openTilePreviewInTab);
  const openPinned = useEpicCanvasStore((s) => s.openTileInTab);
  const tile = useMemo(
    () =>
      makeGitAheadFileDiffTile({
        hostId: props.hostId,
        runningDir: props.repoRoot,
        parentRunningDir: props.parentRunningDir,
        filePath: props.file.path,
      }),
    [props.hostId, props.repoRoot, props.parentRunningDir, props.file.path],
  );
  const onClick = useCallback(
    () => openPreview(props.viewTabId, tile),
    [openPreview, props.viewTabId, tile],
  );
  const onDoubleClick = useCallback(
    () => openPinned(props.viewTabId, tile),
    [openPinned, props.viewTabId, tile],
  );
  return (
    <SubmoduleFileRow
      file={props.file}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    />
  );
}

export function SubmoduleRepoSection(props: {
  readonly view: SubmoduleRepoView;
  readonly hostId: string;
  readonly viewTabId: string;
  /** The owning parent worktree - the source of fresh ahead-of-pin metadata. */
  readonly parentRunningDir: string;
}): ReactNode {
  const { view } = props;
  const wtSections = useMemo(() => {
    const split = splitGitChangedFiles(view.files);
    return [
      { group: "merge" as const, files: split.mergeFiles },
      { group: "staged" as const, files: split.stagedFiles },
      { group: "changes" as const, files: split.changeFiles },
    ].filter((section) => section.files.length > 0);
  }, [view.files]);

  return (
    <section
      className="border-b border-border/60"
      aria-label={`Submodule ${view.label}`}
      data-testid={`submodule-repo-section-${view.parentPath}`}
    >
      <header className="flex items-center gap-2 bg-muted/20 px-3 py-1.5">
        <span className="min-w-0 truncate text-ui-sm font-semibold">
          {view.label}
        </span>
        <span className="shrink-0 rounded bg-muted/40 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
          {view.headLabel}
        </span>
      </header>

      {view.presentation.bucket === "ahead" ? (
        <div>
          <GroupHeading
            title={view.presentation.heading}
            count={view.presentation.files.length}
          />
          <p className="px-3 pb-1 text-ui-xs text-muted-foreground">
            {view.presentation.detail}
          </p>
          {view.presentation.files.map((file) => (
            <SubmoduleAheadFileRow
              key={`ahead:${file.path}`}
              hostId={props.hostId}
              viewTabId={props.viewTabId}
              repoRoot={view.repoRoot}
              parentRunningDir={props.parentRunningDir}
              file={file}
            />
          ))}
        </div>
      ) : (
        <RelationBanner
          tone={
            view.presentation.bucket === "needs-attention"
              ? "attention"
              : "info"
          }
          heading={view.presentation.heading}
          detail={view.presentation.detail}
        />
      )}

      {wtSections.map((section) => (
        <div key={section.group}>
          <GroupHeading
            title={gitBundleGroupLabel(section.group)}
            count={section.files.length}
          />
          {section.files.map((file) => (
            <SubmoduleWtFileRow
              key={`${section.group}:${file.path}`}
              hostId={props.hostId}
              viewTabId={props.viewTabId}
              repoRoot={view.repoRoot}
              file={file}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
