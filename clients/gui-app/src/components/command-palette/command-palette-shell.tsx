/**
 * Modal command palette (⌘K). Presentational shell - dialog, input, grouped
 * list, sub-page stack, dispatch wiring. Items + context come in as props so
 * callers pick which sources participate:
 *
 *   - `CommandPalette` (prod) feeds items from every registered source.
 *   - `CommandPaletteTestShell` skips React-backed sources so palette tests
 *     don't need a full host + query provider stack.
 *
 * The command view/sub-page machinery is shared with the inline in-pane opener via
 * `palette-cmdk.tsx`; this file owns only the modal chrome + the global root
 * (pinned / recents / scope buckets). The opener lives inline in empty panes
 * (`pane-opener.tsx`), not in this modal.
 *
 * Scope narrowing comes from the leading prefix character of the query
 * (`>`, `#`, `@`, `?`). The input shows the raw query with the prefix visible;
 * a custom command filter strips the prefix before substring matching.
 */
import { useCallback, useMemo, type ComponentType, useRef } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaletteItemRow } from "@/components/command-palette/palette-item-row";
import { PinToggle } from "@/components/command-palette/pin-toggle";
import { SubpageView } from "@/components/command-palette/palette-cmdk";
import {
  buildCmdkValue,
  paletteFilter,
  usePaletteController,
} from "@/components/command-palette/palette-cmdk-controller";
import {
  bucketItems,
  buildPinnedBucket,
  buildRecentsBucket,
  filterByScope,
  type CommandGroupBucket,
} from "@/lib/commands/grouping";
import { parseScopePrefix } from "@/lib/commands/scopes";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
import type {
  CommandContext,
  CommandItem as CommandItemShape,
  CommandScope,
} from "@/lib/commands/types";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

const PLACEHOLDER_HINT = "Search commands…";

/**
 * Props the shell hands to the injected root-list component. The shell renders
 * `RootList` ONLY inside the open dialog content, so whatever command sources it
 * subscribes to run only while the palette is open.
 */
export interface PaletteRootListProps {
  readonly ctx: CommandContext;
  readonly effectiveQuery: string;
  readonly effectiveScope: CommandScope | null;
  readonly pinnedIds: ReadonlyArray<string>;
  readonly recentIds: ReadonlyArray<string>;
  readonly onSelect: (item: CommandItemShape) => void;
  readonly onTogglePin: (itemId: string) => void;
}

export interface CommandPaletteShellProps {
  readonly ctx: CommandContext;
  /**
   * Root command list. The shell mounts it only inside the OPEN dialog content
   * (the dialog unmounts content while closed), so the command sources it subscribes
   * to - canvas tabs, keybindings, host, history - don't run and can't
   * re-render the app behind a closed palette. Prod and test inject different
   * source sets via this seam.
   */
  readonly RootList: ComponentType<PaletteRootListProps>;
}

export function CommandPaletteShell(props: CommandPaletteShellProps) {
  const { ctx, RootList } = props;

  const open = useCommandPaletteStore((state) => state.open);
  const query = useCommandPaletteStore((state) => state.query);
  const recentIds = useCommandPaletteStore((state) => state.recentIds);
  const pinnedIds = useCommandPaletteStore((state) => state.pinnedIds);
  const setOpen = useCommandPaletteStore((state) => state.setOpen);
  const setQuery = useCommandPaletteStore((state) => state.setQuery);
  const recordUse = useCommandPaletteStore((state) => state.recordUse);
  const togglePin = useCommandPaletteStore((state) => state.togglePin);

  const parsedPrefix = parseScopePrefix(query);
  const effectiveScope: CommandScope | null = parsedPrefix?.scope ?? null;
  const effectiveQuery = parsedPrefix?.restQuery ?? query;

  const resetQuery = useCallback(() => setQuery(""), [setQuery]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const { activeSubpage, runItem, popSubpage, resetStack } =
    usePaletteController({ ctx, resetQuery, recordUse, close });

  const listRef = useRef<HTMLDivElement>(null);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetStack();
      else
        Analytics.getInstance().track(
          AnalyticsEvent.CommandPaletteOpened,
          null,
        );
      setOpen(next);
    },
    [setOpen, resetStack],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          details.reason === "escape-key" &&
          activeSubpage !== null
        ) {
          details.cancel();
          popSubpage();
        }
        if (details.isCanceled) return;
        handleOpenChange(next);
      }}
    >
      <DialogContent
        layout="banded"
        className="top-[15vh] w-full max-w-[min(90vw,40rem)] translate-y-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command Palette</DialogTitle>
          <DialogDescription>Search for a command to run.</DialogDescription>
        </DialogHeader>
        <Command scoreItem={paletteFilter} label="Search commands">
          <PaletteQueryProvider value={query}>
            <CommandInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                activeSubpage !== null ? activeSubpage.title : PLACEHOLDER_HINT
              }
              aria-label="Search commands"
            />
            <CommandList
              ref={listRef}
              className="min-h-[min(50vh,20rem)] max-h-[60vh]"
              data-testid="command-palette-list"
            >
              {activeSubpage !== null ? (
                <SubpageView
                  key={activeSubpage.id}
                  subpage={activeSubpage}
                  ctx={ctx}
                  onSelect={runItem}
                />
              ) : (
                <RootList
                  ctx={ctx}
                  effectiveQuery={effectiveQuery}
                  effectiveScope={effectiveScope}
                  pinnedIds={pinnedIds}
                  recentIds={recentIds}
                  onSelect={runItem}
                  onTogglePin={togglePin}
                />
              )}
            </CommandList>
          </PaletteQueryProvider>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Root view (global palette)
// ---------------------------------------------------------------------------

export interface RootViewProps extends PaletteRootListProps {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly loading: boolean;
}

export function RootView(props: RootViewProps) {
  const {
    items,
    loading,
    effectiveQuery,
    effectiveScope,
    pinnedIds,
    recentIds,
    onSelect,
    onTogglePin,
  } = props;

  const scopedItems = useMemo(
    () => filterByScope(items, effectiveScope),
    [items, effectiveScope],
  );
  const defaultBuckets = useMemo(() => bucketItems(scopedItems), [scopedItems]);
  const pinned = useMemo(
    () => buildPinnedBucket(pinnedIds, scopedItems),
    [pinnedIds, scopedItems],
  );
  const recents = useMemo(
    () => buildRecentsBucket(recentIds, scopedItems),
    [recentIds, scopedItems],
  );

  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const recentIdSet = useMemo(() => new Set(recentIds), [recentIds]);
  const showRecents = effectiveQuery.trim().length === 0;

  const orderedBuckets = useMemo<ReadonlyArray<CommandGroupBucket>>(() => {
    const hidden = new Set<string>();
    pinnedIdSet.forEach((id) => hidden.add(id));
    if (showRecents) recentIdSet.forEach((id) => hidden.add(id));
    const trimmed = defaultBuckets.flatMap((bucket): CommandGroupBucket[] => {
      const items = bucket.items.filter((item) => !hidden.has(item.id));
      return items.length > 0 ? [{ ...bucket, items }] : [];
    });
    const buckets: Array<CommandGroupBucket> = [];
    if (pinned !== null) buckets.push(pinned);
    if (showRecents && recents !== null) buckets.push(recents);
    const ordered = [...buckets, ...trimmed];
    if (showRecents) return ordered;
    // Best match first, ACROSS groups (C15: "layout" means the layout doors,
    // not a task titled with it). cmdk 1.1.1 means to reorder groups by score
    // but looks each one up by its generated id against a `data-value` that
    // holds the heading, so it never finds one and the default order stands.
    const bestScore = (bucket: CommandGroupBucket): number =>
      Math.max(
        ...bucket.items.map((item) =>
          paletteFilter(buildCmdkValue(item), effectiveQuery, [
            ...item.keywords,
          ]),
        ),
      );
    return ordered
      .map((bucket) => ({ bucket, score: bestScore(bucket) }))
      .toSorted((a, b) => b.score - a.score)
      .map(({ bucket }) => bucket);
  }, [
    defaultBuckets,
    pinned,
    recents,
    pinnedIdSet,
    recentIdSet,
    showRecents,
    effectiveQuery,
  ]);

  return (
    <>
      {loading && items.length === 0 ? null : (
        <CommandEmpty>No commands match.</CommandEmpty>
      )}
      {orderedBuckets.map((bucket, index) => (
        <GroupBlock
          key={bucket.id}
          bucket={bucket}
          onSelect={onSelect}
          onTogglePin={onTogglePin}
          pinnedIdSet={pinnedIdSet}
          withLeadingSeparator={index > 0}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Group renderer
// ---------------------------------------------------------------------------

interface GroupBlockProps {
  readonly bucket: CommandGroupBucket;
  readonly onSelect: (item: CommandItemShape) => void;
  readonly onTogglePin: (itemId: string) => void;
  readonly pinnedIdSet: ReadonlySet<string>;
  readonly withLeadingSeparator: boolean;
}

function GroupBlock(props: GroupBlockProps) {
  const { bucket, onSelect, onTogglePin, pinnedIdSet, withLeadingSeparator } =
    props;
  return (
    <>
      {withLeadingSeparator ? <CommandSeparator /> : null}
      <CommandGroup heading={bucket.label}>
        {bucket.items.map((item) => (
          <PaletteItemRow
            key={item.id}
            itemKey={buildCmdkValue(item)}
            keywords={[...item.keywords]}
            onAction={() => onSelect(item)}
          >
            <span className="truncate">{item.label}</span>
            <PinToggle
              itemId={item.id}
              pinned={pinnedIdSet.has(item.id)}
              onToggle={() => onTogglePin(item.id)}
            />
            {item.shortcut !== null ? (
              <CommandShortcut>
                {formatChordForDisplay(item.shortcut)}
              </CommandShortcut>
            ) : null}
          </PaletteItemRow>
        ))}
      </CommandGroup>
    </>
  );
}
