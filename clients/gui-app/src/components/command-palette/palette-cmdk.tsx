/**
 * Shared cmdk list views used by BOTH the modal command palette
 * (`command-palette-shell.tsx`) and the inline in-pane opener
 * (`components/epic-canvas/canvas/pane-opener.tsx`): the sub-page view and the
 * opener root view. Non-component helpers (filter, row value, controller hook)
 * live in `palette-cmdk-controller.ts`.
 */
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
