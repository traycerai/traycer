/**
 * Shared cmdk list views used by BOTH the modal command palette
 * (`command-palette-shell.tsx`) and the inline in-pane opener
 * (`components/epic-canvas/canvas/pane-opener.tsx`): the sub-page view and the
 * opener root view. Non-component helpers (filter, row value, controller hook)
 * live in `palette-cmdk-controller.ts`.
 */
import { Fragment } from "react";
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

interface SubpageViewProps {
  readonly subpage: CommandSubpage;
  readonly ctx: CommandContext;
  readonly onSelect: (item: CommandItemShape) => void;
}

export function SubpageView(props: SubpageViewProps) {
  const { subpage, ctx, onSelect } = props;
  const items = subpage.useItems(ctx);
  return (
    <>
      {items.length === 0 ? (
        <CommandEmpty>Nothing available.</CommandEmpty>
      ) : null}
      <CommandGroup heading={subpage.title}>
        {items.map((item) => (
          <PaletteItemRow
            key={item.id}
            value={buildCmdkValue(item)}
            keywords={[...item.keywords]}
            onSelect={() => onSelect(item)}
          >
            <SubpageItemLabel label={item.label} />
          </PaletteItemRow>
        ))}
      </CommandGroup>
    </>
  );
}

interface OpenerRootViewProps {
  readonly items: ReadonlyArray<CommandItemShape>;
  readonly onSelect: (item: CommandItemShape) => void;
}

/** The full "Agents → New agent (Chat)" trail a deep row represents. */
function deepRowName(path: ReadonlyArray<string>, label: string): string {
  return [...path, label].join(" → ");
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
      {items.map((item) => (
        <Fragment key={item.id}>
          <PaletteItemRow
            value={buildCmdkValue(item)}
            keywords={[
              ...item.keywords,
              ...path.map((segment) => segment.toLowerCase()),
            ]}
            aria-label={deepRowName(path, item.label)}
            onSelect={() => onSelect(item)}
          >
            <DeepPathLabel path={path} label={item.label} />
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
      ))}
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
