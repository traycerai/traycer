/**
 * Shared cmdk list views used by BOTH the modal command palette
 * (`command-palette-shell.tsx`) and the inline in-pane opener
 * (`components/epic-canvas/canvas/pane-opener.tsx`): the sub-page view and the
 * opener root view. Non-component helpers (filter, row value, controller hook)
 * live in `palette-cmdk-controller.ts`.
 */
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useCommandState } from "cmdk";
import { Bot, Folder, FolderOpen, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BackgroundActivityGlyph } from "@/components/notifications/background-activity-glyph";
import { TreeChevron, TreeChevronSpacer } from "@/components/ui/tree-chevron";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import {
  STATUS_DOT_CLASSES,
  STATUS_LABELS,
  computeArtifactNodeStatusDot,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { cn } from "@/lib/utils";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { GitStatusBadge } from "@/components/epic-canvas/git-diff/git-status-badge";
import { statusBadgeStyle } from "@/lib/git/status-icon";
import {
  useOpenerFileTreeExpandedPaths,
  useOpenerFileTreeStore,
} from "@/stores/file-tree/opener-file-tree-store";
import { CommandEmpty, CommandGroup } from "@/components/ui/command";
import { PaletteItemRow } from "@/components/command-palette/palette-item-row";
import { buildCmdkValue } from "@/components/command-palette/palette-cmdk-controller";
import type {
  CommandContext,
  CommandItem as CommandItemShape,
  CommandSubpage,
} from "@/lib/commands/types";

/**
 * Renders a sub-page row label. File/diff openers use the workspace-relative
 * path as the label (so duplicate basenames like a dozen `index.ts` are
 * distinguishable); we dim the directory and keep the basename at full
 * emphasis. Labels without a separator (every other sub-page) render plain, so
 * this is a no-op for them.
 */
function SubpageItemLabel({ label }: { label: string }) {
  const slash = label.lastIndexOf("/");
  if (slash === -1) {
    return <span className="truncate">{label}</span>;
  }
  return (
    <span className="flex min-w-0 items-baseline">
      <span className="truncate text-muted-foreground">
        {label.slice(0, slash + 1)}
      </span>
      <span className="shrink-0">{label.slice(slash + 1)}</span>
    </span>
  );
}

function AgentTreeIndent(props: {
  readonly depth: number;
  readonly children: ReactNode;
}) {
  if (props.depth === 0) return props.children;
  return (
    <span className="flex min-w-0 border-l border-border/60 pl-3">
      <AgentTreeIndent depth={props.depth - 1}>
        {props.children}
      </AgentTreeIndent>
    </span>
  );
}

function treeDescendantKeywords(
  items: ReadonlyArray<CommandItemShape>,
  getRow: (
    item: CommandItemShape,
  ) =>
    | { readonly nodeId: string; readonly ancestorIds: ReadonlyArray<string> }
    | undefined,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const keywords = new Map<string, string[]>();
  for (const item of items) {
    const row = getRow(item);
    if (row === undefined) continue;
    const searchable = [item.label, ...item.keywords];
    for (const ancestorId of row.ancestorIds) {
      const existing = keywords.get(ancestorId) ?? [];
      existing.push(...searchable);
      keywords.set(ancestorId, existing);
    }
  }
  return keywords;
}

function AgentTreeItemLabel(props: {
  readonly item: CommandItemShape;
  readonly expanded: boolean;
  readonly onToggle: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
}) {
  const row = props.item.agentTreeRow;
  if (row === undefined) return <SubpageItemLabel label={props.item.label} />;
  let statusLabel = "Agent idle";
  let icon =
    row.interface === "chat" ? (
      <MessageSquare aria-hidden className="size-3.5 text-muted-foreground" />
    ) : (
      <Bot aria-hidden className="size-3.5 text-muted-foreground" />
    );
  if (row.activity === "turn") {
    statusLabel = "Agent in progress";
    icon = (
      <AgentSpinningDots
        className="size-3.5 text-primary"
        testId={`agent-opener-running-${props.item.id}`}
        variant="dots2"
      />
    );
  } else if (row.activity === "background") {
    statusLabel = "Agent working in background";
    icon = (
      <BackgroundActivityGlyph
        testId={`agent-opener-background-${props.item.id}`}
      />
    );
  }
  return (
    <AgentTreeIndent depth={row.depth}>
      <span className="flex min-w-0 items-center gap-2">
        {row.hasChildren ? (
          <TreeChevron expanded={props.expanded} onToggle={props.onToggle} />
        ) : (
          <TreeChevronSpacer />
        )}
        <TooltipWrapper
          label={statusLabel}
          side="right"
          sideOffset={undefined}
          align={undefined}
        >
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            role="status"
            aria-label={statusLabel}
          >
            {icon}
          </span>
        </TooltipWrapper>
        <SubpageItemLabel label={props.item.label} />
      </span>
    </AgentTreeIndent>
  );
}

function AgentSubpageRows(props: {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly onSelect: (item: CommandItemShape) => void;
}) {
  // Expansion belongs to this picker instance. It deliberately does not use
  // the sidebar expansion store: collapsing here must not rearrange the user's
  // persistent left-panel tree (and vice versa).
  const [userExpandedIds, setUserExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [userCollapsedIds, setUserCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const search = useCommandState((state) => state.search);
  const selectedValue = useCommandState((state) => state.value);
  const ownerMarkerRef = useRef<HTMLSpanElement>(null);
  const isExpanded = (row: NonNullable<CommandItemShape["agentTreeRow"]>) =>
    !userCollapsedIds.has(row.nodeId) &&
    (row.depth === 0 || userExpandedIds.has(row.nodeId));
  const setRowExpanded = (
    row: NonNullable<CommandItemShape["agentTreeRow"]>,
    expanded: boolean,
  ) => {
    setUserExpandedIds((ids) => {
      const next = new Set(ids);
      if (expanded) next.add(row.nodeId);
      else next.delete(row.nodeId);
      return next;
    });
    setUserCollapsedIds((ids) => {
      const next = new Set(ids);
      if (expanded) next.delete(row.nodeId);
      else next.add(row.nodeId);
      return next;
    });
  };
  const rowByNodeId = new Map(
    props.items.flatMap((item) =>
      item.agentTreeRow === undefined
        ? []
        : [[item.agentTreeRow.nodeId, item.agentTreeRow] as const],
    ),
  );
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const ownerRoot = ownerMarkerRef.current?.closest("[cmdk-root]");
      if (
        !(event.target instanceof Element) ||
        ownerRoot === null ||
        ownerRoot === undefined ||
        event.target.closest("[cmdk-root]") !== ownerRoot
      ) {
        return;
      }
      const item = props.items.find(
        (candidate) => buildCmdkValue(candidate) === selectedValue,
      );
      const row = item?.agentTreeRow;
      if (row?.hasChildren !== true) return;
      const expanded = isExpanded(row);
      if (event.key === "ArrowRight" && !expanded) {
        event.preventDefault();
        event.stopPropagation();
        setRowExpanded(row, true);
      } else if (event.key === "ArrowLeft" && expanded) {
        event.preventDefault();
        event.stopPropagation();
        setRowExpanded(row, false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });
  const descendantKeywords = treeDescendantKeywords(
    props.items,
    (item) => item.agentTreeRow,
  );
  const visibleItems =
    search.length > 0
      ? props.items
      : props.items.filter(
          (item) =>
            item.agentTreeRow === undefined ||
            item.agentTreeRow.ancestorIds.every((id) => {
              const ancestor = rowByNodeId.get(id);
              return ancestor !== undefined && isExpanded(ancestor);
            }),
        );
  const rows = visibleItems.map((item) => {
    const row = item.agentTreeRow;
    const expanded = row !== undefined && isExpanded(row);
    return (
      <PaletteItemRow
        key={item.id}
        value={buildCmdkValue(item)}
        keywords={[
          ...item.keywords,
          ...(descendantKeywords.get(row?.nodeId ?? "") ?? []),
        ]}
        disabled={item.disabled === true}
        onSelect={() => props.onSelect(item)}
      >
        <AgentTreeItemLabel
          item={item}
          expanded={expanded}
          onToggle={
            row?.hasChildren === true
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setRowExpanded(row, !expanded);
                }
              : undefined
          }
        />
        {item.hostBadge !== undefined ? (
          <RowStatusBadge>{item.hostBadge}</RowStatusBadge>
        ) : null}
      </PaletteItemRow>
    );
  });
  return (
    <>
      <span ref={ownerMarkerRef} className="hidden" />
      {rows}
    </>
  );
}

function ArtifactTreeItemLabel(props: {
  readonly item: CommandItemShape;
  readonly expanded: boolean;
  readonly onToggle: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
}) {
  const row = props.item.artifactTreeRow;
  if (row === undefined) return <SubpageItemLabel label={props.item.label} />;
  const Icon = EPIC_NODE_ICONS[row.kind];
  const showStatus = computeArtifactNodeStatusDot(row.kind, row.status);
  const statusLabel =
    row.status === null ? null : (STATUS_LABELS[row.status] ?? "Unknown");
  return (
    <AgentTreeIndent depth={row.depth}>
      <span className="flex min-w-0 items-center gap-2">
        {row.hasChildren ? (
          <TreeChevron expanded={props.expanded} onToggle={props.onToggle} />
        ) : (
          <TreeChevronSpacer />
        )}
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <SubpageItemLabel label={props.item.label} />
        {showStatus && row.status !== null ? (
          <TooltipWrapper
            label={statusLabel ?? "Unknown"}
            side="right"
            sideOffset={undefined}
            align={undefined}
          >
            <span
              aria-label={statusLabel ?? undefined}
              className={cn(
                "size-2 shrink-0 rounded-full",
                STATUS_DOT_CLASSES[row.status] ?? "bg-slate-400",
              )}
              role="status"
            />
          </TooltipWrapper>
        ) : null}
      </span>
    </AgentTreeIndent>
  );
}

function ArtifactSubpageRows(props: {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly onSelect: (item: CommandItemShape) => void;
}) {
  const [userExpandedIds, setUserExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [userCollapsedIds, setUserCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const search = useCommandState((state) => state.search);
  const selectedValue = useCommandState((state) => state.value);
  const ownerMarkerRef = useRef<HTMLSpanElement>(null);
  const isExpanded = (row: NonNullable<CommandItemShape["artifactTreeRow"]>) =>
    !userCollapsedIds.has(row.nodeId) &&
    (row.depth === 0 || userExpandedIds.has(row.nodeId));
  const setRowExpanded = (
    row: NonNullable<CommandItemShape["artifactTreeRow"]>,
    expanded: boolean,
  ) => {
    setUserExpandedIds((ids) => {
      const next = new Set(ids);
      if (expanded) next.add(row.nodeId);
      else next.delete(row.nodeId);
      return next;
    });
    setUserCollapsedIds((ids) => {
      const next = new Set(ids);
      if (expanded) next.delete(row.nodeId);
      else next.add(row.nodeId);
      return next;
    });
  };
  const rowByNodeId = new Map(
    props.items.flatMap((item) =>
      item.artifactTreeRow === undefined
        ? []
        : [[item.artifactTreeRow.nodeId, item.artifactTreeRow] as const],
    ),
  );
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const ownerRoot = ownerMarkerRef.current?.closest("[cmdk-root]");
      if (
        !(event.target instanceof Element) ||
        ownerRoot === null ||
        ownerRoot === undefined ||
        event.target.closest("[cmdk-root]") !== ownerRoot
      ) {
        return;
      }
      const item = props.items.find(
        (candidate) => buildCmdkValue(candidate) === selectedValue,
      );
      const row = item?.artifactTreeRow;
      if (row?.hasChildren !== true) return;
      const expanded = isExpanded(row);
      if (event.key === "ArrowRight" && !expanded) {
        event.preventDefault();
        event.stopPropagation();
        setRowExpanded(row, true);
      } else if (event.key === "ArrowLeft" && expanded) {
        event.preventDefault();
        event.stopPropagation();
        setRowExpanded(row, false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });
  const descendantKeywords = treeDescendantKeywords(
    props.items,
    (item) => item.artifactTreeRow,
  );
  const visibleItems =
    search.length > 0
      ? props.items
      : props.items.filter(
          (item) =>
            item.artifactTreeRow === undefined ||
            item.artifactTreeRow.ancestorIds.every((id) => {
              const ancestor = rowByNodeId.get(id);
              return ancestor !== undefined && isExpanded(ancestor);
            }),
        );
  const rows = visibleItems.map((item) => {
    const row = item.artifactTreeRow;
    const expanded = row !== undefined && isExpanded(row);
    return (
      <PaletteItemRow
        key={item.id}
        value={buildCmdkValue(item)}
        keywords={[
          ...item.keywords,
          ...(descendantKeywords.get(row?.nodeId ?? "") ?? []),
        ]}
        disabled={item.disabled === true}
        onSelect={() => props.onSelect(item)}
      >
        <ArtifactTreeItemLabel
          item={item}
          expanded={expanded}
          onToggle={
            row?.hasChildren === true
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setRowExpanded(row, !expanded);
                }
              : undefined
          }
        />
      </PaletteItemRow>
    );
  });
  return (
    <>
      <span ref={ownerMarkerRef} className="hidden" />
      {rows}
    </>
  );
}

function PathTreeItemLabel(props: {
  readonly item: CommandItemShape;
  readonly expanded: boolean;
  readonly onToggle: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
}) {
  const row = props.item.pathTreeRow;
  if (row === undefined) return <SubpageItemLabel label={props.item.label} />;
  const FolderIcon = props.expanded ? FolderOpen : Folder;
  const gitStyle =
    row.gitStatus === undefined ? null : statusBadgeStyle(row.gitStatus);
  return (
    <AgentTreeIndent depth={row.depth}>
      <span className="flex min-w-0 items-center gap-2">
        {row.hasChildren ? (
          <TreeChevron expanded={props.expanded} onToggle={props.onToggle} />
        ) : (
          <TreeChevronSpacer />
        )}
        {row.kind === "directory" ? (
          <FolderIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <MaterialFileIcon filename={row.path} className="size-4 shrink-0" />
        )}
        <SubpageItemLabel label={props.item.label} />
        {gitStyle === null ? null : (
          <GitStatusBadge
            letter={gitStyle.letter}
            tone={gitStyle.tone}
            label={gitStyle.label}
            withTooltip
            className={cn(
              "ml-auto h-4 min-w-4 px-0.5",
              gitStyle.tone === "muted" && "bg-foreground/8",
            )}
          />
        )}
      </span>
    </AgentTreeIndent>
  );
}

function PathSubpageRows(props: {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly onSelect: (item: CommandItemShape) => void;
}) {
  const treeId =
    props.items.find((item) => item.pathTreeRow !== undefined)?.pathTreeRow
      ?.treeId ?? "";
  const expandedPaths = useOpenerFileTreeExpandedPaths(treeId);
  const togglePath = useOpenerFileTreeStore((state) => state.toggle);
  const search = useCommandState((state) => state.search);
  const selectedValue = useCommandState((state) => state.value);
  const ownerMarkerRef = useRef<HTMLSpanElement>(null);
  const isExpanded = (row: NonNullable<CommandItemShape["pathTreeRow"]>) =>
    expandedPaths.includes(`${row.path}/`);
  const rowByNodeId = new Map(
    props.items.flatMap((item) =>
      item.pathTreeRow === undefined
        ? []
        : [[item.pathTreeRow.nodeId, item.pathTreeRow] as const],
    ),
  );
  const toggle = (row: NonNullable<CommandItemShape["pathTreeRow"]>) => {
    togglePath(row.treeId, `${row.path}/`);
  };
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const ownerRoot = ownerMarkerRef.current?.closest("[cmdk-root]");
      if (
        !(event.target instanceof Element) ||
        ownerRoot === null ||
        ownerRoot === undefined ||
        event.target.closest("[cmdk-root]") !== ownerRoot
      ) {
        return;
      }
      const item = props.items.find(
        (candidate) => buildCmdkValue(candidate) === selectedValue,
      );
      const row = item?.pathTreeRow;
      if (row?.hasChildren !== true) return;
      const expanded = isExpanded(row);
      if (
        (event.key === "ArrowRight" && !expanded) ||
        (event.key === "ArrowLeft" && expanded)
      ) {
        event.preventDefault();
        event.stopPropagation();
        toggle(row);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });
  const visibleItems =
    search.length > 0
      ? props.items
      : props.items.filter(
          (item) =>
            item.pathTreeRow === undefined ||
            item.pathTreeRow.ancestorIds.every((id) => {
              const ancestor = rowByNodeId.get(id);
              return ancestor !== undefined && isExpanded(ancestor);
            }),
        );
  const rows = visibleItems.map((item) => {
    const row = item.pathTreeRow;
    const expanded = row !== undefined && isExpanded(row);
    return (
      <PaletteItemRow
        key={item.id}
        value={buildCmdkValue(item)}
        keywords={[...item.keywords]}
        disabled={item.disabled === true}
        onSelect={() => {
          if (row?.kind === "directory") toggle(row);
          else props.onSelect(item);
        }}
      >
        <PathTreeItemLabel
          item={item}
          expanded={expanded}
          onToggle={
            row?.hasChildren === true
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggle(row);
                }
              : undefined
          }
        />
      </PaletteItemRow>
    );
  });
  return (
    <>
      <span ref={ownerMarkerRef} className="hidden" />
      {rows}
    </>
  );
}

function RowStatusBadge({ children }: { readonly children: string }) {
  return (
    <Badge
      variant="outline"
      className="ml-auto shrink-0 border-border/70 bg-background/60 text-muted-foreground"
    >
      {children}
    </Badge>
  );
}

interface SubpageViewProps {
  readonly subpage: CommandSubpage;
  readonly ctx: CommandContext;
  readonly onSelect: (item: CommandItemShape) => void;
}

export function SubpageView(props: SubpageViewProps) {
  const { subpage, ctx, onSelect } = props;
  const items = subpage.useItems(ctx);
  let rows: ReactNode;
  if (subpage.id === "open:agents") {
    rows = <AgentSubpageRows items={items} onSelect={onSelect} />;
  } else if (subpage.id === "open:artifacts") {
    rows = <ArtifactSubpageRows items={items} onSelect={onSelect} />;
  } else if (items.some((item) => item.pathTreeRow !== undefined)) {
    rows = <PathSubpageRows items={items} onSelect={onSelect} />;
  } else {
    rows = items.map((item) => (
      <PaletteItemRow
        key={item.id}
        value={buildCmdkValue(item)}
        keywords={[...item.keywords]}
        disabled={item.disabled === true}
        onSelect={() => onSelect(item)}
      >
        <SubpageItemLabel label={item.label} />
        {item.hostBadge !== undefined ? (
          <RowStatusBadge>{item.hostBadge}</RowStatusBadge>
        ) : null}
        {item.statusBadge !== undefined ? (
          <RowStatusBadge>{item.statusBadge}</RowStatusBadge>
        ) : null}
      </PaletteItemRow>
    ));
  }
  return (
    <>
      {items.length === 0 ? (
        <CommandEmpty>Nothing available.</CommandEmpty>
      ) : null}
      <CommandGroup heading={subpage.title}>{rows}</CommandGroup>
    </>
  );
}

interface OpenerRootViewProps {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly onSelect: (item: CommandItemShape) => void;
}

/** The full "Agents → New agent (Chat)" trail a deep row represents. */
function deepRowName(
  path: ReadonlyArray<string>,
  label: string,
  statusBadge: string | undefined,
): string {
  return statusBadge === undefined
    ? [...path, label].join(" → ")
    : [...path, label, statusBadge].join(" → ");
}

/**
 * Deep-row label: the sub-page path dimmed ("Agents → "), then the leaf label
 * through `SubpageItemLabel` so file-path labels keep their directory dimming.
 * The row carries an explicit `aria-label` (see `deepRowName`) because the
 * separators here are split across elements and styled with a flex `gap` - the
 * name computed from text content alone would run them together.
 */
function DeepPathLabel(props: {
  readonly path: ReadonlyArray<string>;
  readonly label: string;
}) {
  const { path, label } = props;
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="truncate text-muted-foreground">
        {path.join(" → ")} →
      </span>
      <SubpageItemLabel label={label} />
    </span>
  );
}

/**
 * Depth bound for the deep view's recursion. The opener's own sub-pages bottom
 * out at level 3 (category → workspace → file); the cap only exists so a future
 * self-referential sub-page can't recurse the renderer to a hang.
 */
const OPENER_DEEP_MAX_DEPTH = 4;

interface OpenerDeepRowsProps {
  readonly subpage: CommandSubpage;
  readonly ctx: CommandContext;
  readonly path: ReadonlyArray<string>;
  readonly onSelect: (item: CommandItemShape) => void;
}

/**
 * One sub-page's rows for the deep view, recursing into nested sub-pages.
 * Recursion is per-component (one `useItems` hook call each), so a dynamic
 * number of nested sub-pages stays rules-of-hooks safe. The path segments are
 * appended to the row's keywords so combined queries like "agents new" match.
 */
function OpenerDeepRows(props: OpenerDeepRowsProps) {
  const { subpage, ctx, path, onSelect } = props;
  const items = subpage.useItems(ctx);
  return (
    <>
      {items
        .filter((item) => item.pathTreeRow?.kind !== "directory")
        .map((item) => {
          const rowIdentity = `${subpage.id}:${item.id}`;
          return (
            <Fragment key={rowIdentity}>
              <PaletteItemRow
                value={`${rowIdentity} ${buildCmdkValue(item)}`}
                keywords={[
                  ...item.keywords,
                  ...path.map((segment) => segment.toLowerCase()),
                ]}
                aria-label={deepRowName(path, item.label, item.statusBadge)}
                disabled={item.disabled === true}
                onSelect={() => onSelect(item)}
              >
                <DeepPathLabel
                  path={path}
                  label={item.pathTreeRow?.displayPath ?? item.label}
                />
                {item.statusBadge !== undefined ? (
                  <RowStatusBadge>{item.statusBadge}</RowStatusBadge>
                ) : null}
              </PaletteItemRow>
              {item.subpage !== null && path.length < OPENER_DEEP_MAX_DEPTH ? (
                <OpenerDeepRows
                  subpage={item.subpage}
                  ctx={ctx}
                  path={[...path, item.label]}
                  onSelect={onSelect}
                />
              ) : null}
            </Fragment>
          );
        })}
    </>
  );
}

interface OpenerDeepViewProps {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly ctx: CommandContext;
  readonly onSelect: (item: CommandItemShape) => void;
}

/**
 * Flattened deep matches for the opener root: every sub-page leaf, any number
 * of levels down, rendered with its full category path so a root query like
 * "create" surfaces "Agents → New agent (Chat)" without drilling in. Mounted
 * only while a query is typed (the empty-query root shows categories alone);
 * cmdk's filter owns which rows actually show.
 */
export function OpenerDeepView(props: OpenerDeepViewProps) {
  const { items, ctx, onSelect } = props;
  const categories = items.filter(
    (item): item is CommandItemShape & { readonly subpage: CommandSubpage } =>
      item.subpage !== null,
  );
  return (
    <CommandGroup>
      {categories.map((item) => (
        <OpenerDeepRows
          key={item.id}
          subpage={item.subpage}
          ctx={ctx}
          path={[item.label]}
          onSelect={onSelect}
        />
      ))}
    </CommandGroup>
  );
}

/**
 * Opener root: the category entries (each pushes a sub-page). Used by the
 * in-pane opener; the modal palette's global root lives in the shell.
 */
export function OpenerRootView(props: OpenerRootViewProps) {
  const { items, onSelect } = props;
  return (
    <>
      {items.length === 0 ? (
        <CommandEmpty>Nothing to open.</CommandEmpty>
      ) : null}
      <CommandGroup heading="Open into pane">
        {items.map((item) => (
          <PaletteItemRow
            key={item.id}
            value={buildCmdkValue(item)}
            keywords={[...item.keywords]}
            onSelect={() => onSelect(item)}
          >
            <span className="truncate">{item.label}</span>
          </PaletteItemRow>
        ))}
      </CommandGroup>
    </>
  );
}
