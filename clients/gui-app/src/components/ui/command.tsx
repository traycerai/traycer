import * as React from "react";
import {
  createOpenerFileTreeStore,
  OpenerFileTreeContext,
} from "@/stores/file-tree/opener-file-tree-store";
import { commandScore } from "@/lib/command-score";
import {
  CommandContext,
  isCommandCompositionKey,
  CommandGroupContext,
  useCommandContext,
  type CommandRow,
  type CommandGroupRecord,
} from "./command-context";

import { cn } from "@/lib/utils";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { SearchIcon, CheckIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";

interface CommandProps extends Omit<
  React.ComponentProps<"div">,
  "defaultValue"
> {
  readonly variant?: "standalone" | "embedded";
  readonly selection?: "lifted" | "flat";
  readonly label?: string;
  readonly shouldFilter?: boolean;
  readonly scoreItem?: (
    text: string,
    query: string,
    keywords: string[],
  ) => number;
  readonly highlightedValue?: string;
  readonly defaultHighlightedValue?: string;
  readonly onHighlightChange?: (value: string) => void;
  readonly allowDisabledHighlight?: boolean;
  readonly loopNavigation?: boolean;
}

function sourceOrder(
  a: { anchor: HTMLTemplateElement },
  b: { anchor: HTMLTemplateElement },
): number {
  return a.anchor.compareDocumentPosition(b.anchor) &
    Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}

function committedSourcePositions(
  rows: readonly CommandRow[],
  groups: readonly CommandGroupRecord[],
): ReadonlyMap<string, number> {
  return new Map(
    [...rows, ...groups]
      .filter((entry) => entry.anchor.isConnected)
      .sort(sourceOrder)
      .map((entry, index) => [entry.id, index]),
  );
}

function orderCommandElements(
  entries: readonly CommandGroupRecord[],
  ranked: boolean,
): void {
  const nextByParent = new Map<HTMLElement, HTMLElement>();
  for (const entry of [...entries].reverse()) {
    if (!ranked) {
      if (entry.anchor.nextSibling !== entry.element)
        entry.anchor.after(entry.element);
      continue;
    }
    const parent = entry.element.parentElement;
    if (!parent) continue;
    const next = nextByParent.get(parent) ?? null;
    // Avoid detaching an already ordered row: it may contain a focused action.
    if (entry.element.nextSibling !== next)
      parent.insertBefore(entry.element, next);
    nextByParent.set(parent, entry.element);
  }
}

function commandCollection({
  rows,
  groups,
  query,
  shouldFilter,
  scoreItem,
  sourcePositions,
}: {
  readonly sourcePositions: ReadonlyMap<string, number>;
  readonly rows: readonly CommandRow[];
  readonly groups: readonly CommandGroupRecord[];
  readonly query: string;
  readonly shouldFilter: boolean;
  readonly scoreItem: (
    text: string,
    query: string,
    keywords: string[],
  ) => number;
}) {
  const compareSource = (a: { id: string }, b: { id: string }) =>
    (sourcePositions.get(a.id) ?? 0) - (sourcePositions.get(b.id) ?? 0);
  const scores = new Map(
    rows.map((row) => [
      row.id,
      shouldFilter && query.trim()
        ? scoreItem(row.text, query.trim(), row.keywords)
        : 1,
    ]),
  );
  const ranked = rows
    .filter((row) => row.element.isConnected && (scores.get(row.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
        compareSource(a, b),
    );
  const groupScore = (id: string) =>
    Math.max(
      0,
      ...ranked
        .filter((row) => row.group === id)
        .map((row) => scores.get(row.id) ?? 0),
    );
  const blocks = [
    ...groups.map((group) => ({
      ...group,
      score: groupScore(group.id),
      rows: ranked.filter((row) => row.group === group.id),
    })),
    ...ranked
      .filter((row) => row.group === null)
      .map((row) => ({ ...row, score: scores.get(row.id) ?? 0, rows: [row] })),
  ].sort((a, b) => b.score - a.score || compareSource(a, b));
  const ordered = blocks.flatMap((block) => block.rows);
  const enabled = ordered.filter((row) => !row.disabled);
  return { scores, ranked, blocks, enabled };
}

function commandNavigationKey(
  event: React.KeyboardEvent<HTMLDivElement>,
): string {
  let key = event.key;
  if (event.ctrlKey && (key === "n" || key === "j")) key = "ArrowDown";
  if (event.ctrlKey && (key === "p" || key === "k")) key = "ArrowUp";
  if (key !== "ArrowDown" && key !== "ArrowUp") return key;
  if (event.metaKey) return key === "ArrowDown" ? "End" : "Home";
  if (event.altKey) return key === "ArrowDown" ? "GroupDown" : "GroupUp";
  return key;
}

function adjacentCommandGroupRow(
  rows: readonly CommandRow[],
  selectedId: string | undefined,
  key: string,
): CommandRow | undefined {
  if (key !== "GroupDown" && key !== "GroupUp") return undefined;
  const group = rows.find((row) => row.id === selectedId)?.group;
  if (!group) return undefined;
  const groupIds = [
    ...new Set(rows.flatMap((row) => (row.group === null ? [] : [row.group]))),
  ];
  const nextIndex = groupIds.indexOf(group) + (key === "GroupDown" ? 1 : -1);
  const nextGroup = groupIds.find((_, index) => index === nextIndex);
  return rows.find((row) => row.group === nextGroup);
}

function commandNavigationIndex({
  key,
  index,
  count,
  pageSize,
  loop,
}: {
  readonly key: string;
  readonly index: number;
  readonly count: number;
  readonly pageSize: number;
  readonly loop: boolean;
}): number {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const deltas: Record<string, number> = {
    ArrowDown: 1,
    ArrowUp: -1,
    GroupDown: 1,
    GroupUp: -1,
    PageDown: pageSize,
    PageUp: -pageSize,
  };
  let next = index + (deltas[key] ?? 0);
  if (loop && ["ArrowDown", "ArrowUp", "GroupDown", "GroupUp"].includes(key))
    next = (next + count) % count;
  return Math.max(0, Math.min(count - 1, next));
}

function Command({
  className,
  variant = "standalone",
  selection = "lifted",
  label = "Suggestions",
  shouldFilter = true,
  scoreItem = commandScore,
  highlightedValue,
  defaultHighlightedValue = "",
  onHighlightChange,
  allowDisabledHighlight,
  loopNavigation = false,
  onKeyDown,
  onKeyDownCapture,
  children,
  ...props
}: CommandProps) {
  const [treeStore] = React.useState(createOpenerFileTreeStore);
  const listId = React.useId();
  const listRef = React.useRef<HTMLDivElement>(null);
  const composition = React.useRef({ active: false, endedAt: -Infinity });
  const [query, setQueryState] = React.useState("");
  const [rows, setRows] = React.useState<CommandRow[]>([]);
  const [groups, setGroups] = React.useState<CommandGroupRecord[]>([]);
  const [sourcePositions, setSourcePositions] = React.useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [active, setActive] = React.useState(defaultHighlightedValue);
  const [activeRowId, setActiveRowId] = React.useState<string | undefined>();
  const registerRow = React.useCallback((row: CommandRow) => {
    setRows((current) => [
      ...current.filter((item) => item.id !== row.id),
      row,
    ]);
    return () =>
      setRows((current) => current.filter((item) => item.id !== row.id));
  }, []);
  const registerGroup = React.useCallback((group: CommandGroupRecord) => {
    setGroups((current) => [
      ...current.filter((item) => item.id !== group.id),
      group,
    ]);
    return () =>
      setGroups((current) => current.filter((item) => item.id !== group.id));
  }, []);
  const { scores, ranked, enabled } = React.useMemo(
    () =>
      commandCollection({
        rows,
        groups,
        query,
        shouldFilter,
        scoreItem,
        sourcePositions,
      }),
    [rows, groups, query, shouldFilter, scoreItem, sourcePositions],
  );
  const currentValue = highlightedValue ?? active;
  const selectable =
    allowDisabledHighlight === true
      ? rows.filter((row) => !row.element.hidden)
      : enabled;
  const selected =
    selectable.find(
      (row) => row.id === activeRowId && row.key === currentValue,
    ) ??
    selectable.find((row) => row.key === currentValue) ??
    enabled.at(0);
  const setHighlightedRow = React.useCallback(
    (row: CommandRow) => {
      setActiveRowId(row.id);
      setActive(row.key);
      if (row.key !== currentValue) onHighlightChange?.(row.key);
    },
    [currentValue, onHighlightChange],
  );
  const highlight = (id: string) => {
    const row = enabled.find((candidate) => candidate.id === id);
    if (row) setHighlightedRow(row);
  };
  const setQuery = React.useCallback(
    (next: string) => {
      if (next === query) return;
      const first = commandCollection({
        rows,
        groups,
        query: next,
        sourcePositions: committedSourcePositions(rows, groups),
        shouldFilter,
        scoreItem,
      }).enabled.at(0);
      setQueryState(next);
      setActive(first?.key ?? "");
      setActiveRowId(first?.id);
      onHighlightChange?.(first?.key ?? "");
    },
    [query, rows, groups, shouldFilter, scoreItem, onHighlightChange],
  );
  React.useLayoutEffect(() => {
    const refresh = () => {
      // React has now moved keyed anchors. Never rank using a render-time
      // DOM snapshot, which still described the previous caller order.
      const positions = committedSourcePositions(rows, groups);
      setSourcePositions((current) =>
        current.size === positions.size &&
        [...positions].every(([id, index]) => current.get(id) === index)
          ? current
          : positions,
      );
      const committed = commandCollection({
        rows,
        groups,
        query,
        shouldFilter,
        scoreItem,
        sourcePositions: positions,
      });
      const filtering = shouldFilter && query.trim().length > 0;
      orderCommandElements(
        committed.ranked.filter((row) => row.group !== null),
        filtering,
      );
      orderCommandElements(committed.blocks, filtering);
    };
    refresh();
    // A nested consumer can reorder cached row elements without rendering
    // Command itself. Observe those commits too; unchanged order is a no-op.
    const observer = new MutationObserver(refresh);
    if (listRef.current)
      observer.observe(listRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rows, groups, query, shouldFilter, scoreItem]);
  React.useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);
  const effectiveValue = selected?.key ?? "";
  React.useLayoutEffect(() => {
    // The first parent commit precedes the rows' registration render.
    if (
      rows.length > 0 &&
      rows.every((row) => sourcePositions.has(row.id)) &&
      effectiveValue !== currentValue
    )
      onHighlightChange?.(effectiveValue);
  }, [rows, sourcePositions, effectiveValue, currentValue, onHighlightChange]);
  React.useLayoutEffect(() => {
    if (selected) selected.element.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const navigate = (event: React.KeyboardEvent<HTMLDivElement>): boolean => {
    const key = commandNavigationKey(event);
    if (
      ![
        "ArrowDown",
        "ArrowUp",
        "Home",
        "End",
        "PageDown",
        "PageUp",
        "GroupDown",
        "GroupUp",
      ].includes(key)
    )
      return false;
    // An immediate event can precede the observer for a nested caller reorder.
    const { enabled } = commandCollection({
      rows,
      groups,
      query,
      shouldFilter,
      scoreItem,
      sourcePositions: committedSourcePositions(rows, groups),
    });
    if (!enabled.length) return false;
    const index = enabled.findIndex((row) => row.id === selected?.id);
    const pageSize = Math.max(
      1,
      Math.floor(
        (listRef.current?.clientHeight ?? 0) /
          (enabled[0].element.offsetHeight || 36),
      ) - 1,
    );
    const target =
      adjacentCommandGroupRow(enabled, selected?.id, key) ??
      enabled[
        commandNavigationIndex({
          key,
          index,
          count: enabled.length,
          pageSize,
          loop: loopNavigation,
        })
      ];
    setHighlightedRow(target);
    return true;
  };
  return (
    <OpenerFileTreeContext.Provider value={treeStore}>
      <CommandContext.Provider
        value={{
          query,
          setQuery,
          highlightedValue: effectiveValue,
          activeId: selected?.id,
          highlight,
          scores,
          count: ranked.length,
          visibleGroups: new Set(
            ranked.flatMap((row) => (row.group === null ? [] : [row.group])),
          ),
          listId,
          label,
          listRef,
          registerRow,
          registerGroup,
        }}
      >
        <div
          role="presentation"
          data-slot="command"
          data-variant={variant}
          data-selection={selection}
          className={cn(
            "group/command flex size-full flex-col overflow-hidden text-popover-foreground",
            variant === "embedded"
              ? "bg-transparent p-0"
              : "rounded-xl bg-[var(--command-surface-background,var(--popover))] p-1",
            className,
          )}
          {...props}
          onCompositionStart={() => {
            composition.current.active = true;
          }}
          onCompositionEnd={(event) => {
            composition.current = { active: false, endedAt: event.timeStamp };
          }}
          onKeyDownCapture={(event) => {
            // Run before consumer input handlers, leaving native IME default behavior intact.
            if (
              isCommandCompositionKey(event.nativeEvent, composition.current)
            ) {
              event.stopPropagation();
              return;
            }
            onKeyDownCapture?.(event);
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            // A button nested in a row keeps its native activation.
            if (
              event.target instanceof Element &&
              event.target.closest("button, a, textarea")
            )
              return;
            if (event.key === "Enter") {
              event.preventDefault();
              selected?.element.click();
              return;
            }
            if (navigate(event)) event.preventDefault();
          }}
        >
          {children}
        </div>
      </CommandContext.Provider>
    </OpenerFileTreeContext.Provider>
  );
}

function CommandInput({
  className,
  leading,
  value,
  onChange,
  ...props
}: React.ComponentProps<"input"> & {
  /**
   * Optional leading affordance rendered in place of the search icon - e.g. a
   * back button when the surface has drilled into a sub-page.
   */
  leading?: React.ReactNode;
}) {
  const context = useCommandContext();
  const { setQuery } = context;
  React.useLayoutEffect(() => {
    if (value !== undefined) setQuery(String(value));
  }, [value, setQuery]);
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <InputGroup
        variant="search"
        className="h-8! border-[color-mix(in_srgb,var(--input)_30%,var(--popover))] bg-[color-mix(in_srgb,var(--input)_30%,var(--popover))]!"
      >
        <input
          data-slot="command-input"
          className={cn(
            "w-full text-ui-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
          role="combobox"
          aria-label={props["aria-label"] ?? context.label}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={context.listId}
          aria-activedescendant={context.activeId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={props.spellCheck ?? false}
          value={value ?? context.query}
          onChange={(event) => {
            context.setQuery(event.target.value);
            onChange?.(event);
          }}
        />
        <InputGroupAddon>
          {leading ?? <SearchIcon className="size-4 shrink-0 opacity-50" />}
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  ref,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const context = useCommandContext();
  const { listRef } = context;
  return (
    <div
      {...props}
      ref={(node) => {
        listRef.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      id={context.listId}
      role="listbox"
      aria-label={context.label}
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none [overflow-anchor:none]",
        className,
      )}
    >
      <div data-slot="command-list-content">{children}</div>
    </div>
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<"div">) {
  const context = useCommandContext();
  if (context.count > 0) return null;
  return (
    <div
      role="presentation"
      data-slot="command-empty"
      className={cn("py-6 text-center text-ui-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  heading,
  children,
  ...props
}: React.ComponentProps<"div"> & { readonly heading?: React.ReactNode }) {
  const id = React.useId();
  const context = useCommandContext();
  const element = React.useRef<HTMLDivElement>(null);
  const anchor = React.useRef<HTMLTemplateElement>(null);
  const { registerGroup } = context;
  React.useLayoutEffect(() => {
    if (!element.current || !anchor.current) return;
    return registerGroup({
      id,
      element: element.current,
      anchor: anchor.current,
    });
  }, [id, registerGroup]);
  // Children register even when filtered, so the query can reveal them again.
  const hidden = !context.visibleGroups.has(id);
  return (
    <CommandGroupContext.Provider value={id}>
      <template ref={anchor} />
      <div
        {...props}
        ref={element}
        data-slot="command-group"
        hidden={hidden}
        className={cn(
          "overflow-hidden p-1 text-foreground **:data-[slot=command-group-heading]:px-2 **:data-[slot=command-group-heading]:py-1.5 **:data-[slot=command-group-heading]:text-ui-xs **:data-[slot=command-group-heading]:font-medium **:data-[slot=command-group-heading]:text-muted-foreground",
          className,
        )}
      >
        {heading ? (
          <div
            data-slot="command-group-heading"
            aria-hidden="true"
            id={id + "-heading"}
          >
            {heading}
          </div>
        ) : null}
        <div
          role="group"
          aria-labelledby={heading ? id + "-heading" : undefined}
        >
          {children}
        </div>
      </div>
    </CommandGroupContext.Provider>
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const context = useCommandContext();
  if (context.query) return null;
  return (
    <div
      role="separator"
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  itemKey,
  searchText,
  keywords = [],
  disabled = false,
  hidden: hiddenProp = false,
  onAction,
  showCheck = true,
  ref,
  onClick,
  onMouseMove,
  onMouseDown,
  ...props
}: Omit<React.ComponentProps<"div">, "onSelect"> & {
  readonly itemKey?: string;
  readonly searchText?: string;
  readonly keywords?: string[];
  readonly disabled?: boolean;
  readonly onAction?: () => void;
  readonly showCheck?: boolean;
}) {
  const id = React.useId();
  const context = useCommandContext();
  const group = React.useContext(CommandGroupContext);
  const element = React.useRef<HTMLDivElement>(null);
  const anchor = React.useRef<HTMLTemplateElement>(null);
  const { registerRow } = context;
  const [inferredText, setInferredText] = React.useState("");
  React.useLayoutEffect(() => {
    if (searchText === undefined && itemKey === undefined)
      setInferredText(element.current?.textContent ?? "");
  }, [children, itemKey, searchText]);
  const keywordKey = JSON.stringify(keywords);
  const keywordsRef = React.useRef(keywords);
  React.useLayoutEffect(() => {
    keywordsRef.current = keywords;
  });
  React.useLayoutEffect(() => {
    if (!element.current || !anchor.current) return;
    const text = searchText ?? itemKey ?? inferredText;
    return registerRow({
      id,
      key: itemKey ?? text,
      text,
      keywords: keywordsRef.current,
      disabled: disabled || hiddenProp,
      group,
      element: element.current,
      anchor: anchor.current,
    });
  }, [
    id,
    itemKey,
    searchText,
    inferredText,
    keywordKey,
    disabled,
    hiddenProp,
    group,
    registerRow,
  ]);
  const selected = context.activeId === id;
  const hidden =
    hiddenProp || (context.scores.has(id) && context.scores.get(id) === 0);
  return (
    <>
      <template ref={anchor} />
      <div
        data-slot="command-item"
        className={cn(
          "group/command-item relative flex cursor-default items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 text-ui-sm outline-hidden select-none transition-[background-color,border-color,box-shadow,color] duration-150 in-data-[slot=dialog-content]:rounded-lg data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:border-primary/35 data-[selected=true]:bg-[color-mix(in_srgb,var(--primary)_14%,var(--popover))] data-[selected=true]:text-foreground data-[selected=true]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-primary",
          // An action palette (`showCheck={false}`) has no hover fill: the row
          // under a moving pointer is already the selected one, so a fill only
          // paints a SECOND highlight on whatever row a resting pointer sits
          // over when the palette opens or the list reorders.
          showCheck &&
            "hover:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--popover))] hover:text-foreground active:press-scrim",
          // `selection="flat"` (see `Command`): the cursor stops competing with
          // the primary the CHOSEN row is marked in. A foreground alpha rather
          // than `bg-accent`, which both sites reached for and which AGENTS.md
          // rules out on a raised surface.
          "group-data-[selection=flat]/command:data-[selected=true]:border-transparent group-data-[selection=flat]/command:data-[selected=true]:bg-foreground/8 group-data-[selection=flat]/command:data-[selected=true]:shadow-none group-data-[selection=flat]/command:data-[selected=true]:*:[svg]:text-current",
          // …and the primary it gave up is what the CHOSEN row takes instead,
          // which is the whole point of the split.
          "group-data-[selection=flat]/command:data-[checked=true]:text-primary",
          className,
        )}
        {...props}
        ref={(node) => {
          element.current = node;
          if (typeof ref === "function") return ref(node);
          if (ref) ref.current = node;
        }}
        id={id}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-disabled={disabled}
        data-selected={selected}
        data-disabled={disabled}
        data-value={itemKey}
        hidden={hidden}
        onMouseMove={(event) => {
          onMouseMove?.(event);
          if (!disabled && !event.defaultPrevented) context.highlight(id);
        }}
        onMouseDown={(event) => {
          onMouseDown?.(event);
          event.preventDefault();
        }}
        onClick={(event) => {
          if (disabled) return;
          onClick?.(event);
          if (!event.defaultPrevented) {
            context.highlight(id);
            onAction?.();
          }
        }}
      >
        {children}
        {showCheck ? (
          <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
        ) : null}
      </div>
    </>
  );
}

// The row's trailing chord chip. Gated as a whole rather than at its one call
// site: the wrapper span is also what `CommandItem` keys its check-mark off
// (`group-has-data-[slot=command-shortcut]`), so a bound command must either
// show its chord or read as a plain row.
function CommandShortcut({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <ShortcutHint>
      <span
        data-slot="command-shortcut"
        className={cn(
          "ml-auto text-ui-xs text-muted-foreground group-data-[selected=true]/command-item:text-foreground",
          className,
        )}
        {...props}
      >
        {/* Repeated on the keycap because the span above only sets an INHERITED
            color, and `Kbd` paints its own `text-muted-foreground` directly on
            the element, which beats it. */}
        <Kbd
          className="tabular-nums group-data-[selected=true]/command-item:text-foreground"
          variant="mono"
        >
          {children}
        </Kbd>
      </span>
    </ShortcutHint>
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
