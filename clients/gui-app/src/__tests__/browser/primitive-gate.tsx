import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as Avatar from "@/components/ui/avatar";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import * as Radio from "@/components/ui/radio-group";
import * as Slider from "@/components/ui/slider";
import * as Tabs from "@/components/ui/tabs";
import * as Collapsible from "@/components/ui/collapsible";
import * as Sidebar from "@/components/ui/sidebar";
import * as Dialog from "@/components/ui/dialog";
import * as Sheet from "@/components/ui/sheet";
import * as Drawer from "@/components/ui/drawer";
import * as Popover from "@/components/ui/popover";
import * as Tooltip from "@/components/ui/tooltip";
import * as Hover from "@/components/ui/hover-card";
import * as Menu from "@/components/ui/dropdown-menu";
import * as Context from "@/components/ui/context-menu";
import * as Menubar from "@/components/ui/menubar";
import * as Select from "@/components/ui/select";
import * as Command from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import {
  PortalConcealmentBoundary,
  PortalConcealmentProvider,
} from "@/components/ui/portal-concealment-context";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { PromotableModalFrame } from "@/components/layout/dialogs/promotable-modal-frame";
import {
  OverlayFrameContext,
  useOverlayFrame,
} from "@/components/ui/overlay-frame-context";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { escapeOwnedElsewhere } from "@/components/onboarding/guide-overlays";
import { PinToggle } from "@/components/command-palette/pin-toggle";
import { SubpageView } from "@/components/command-palette/palette-cmdk";
import {
  buildPathTreeItems,
  openerPathTreeId,
  type PathTreeLeaf,
} from "@/lib/commands/sources/open/path-tree-items";
import { openerActionLeaf } from "@/lib/commands/sources/open/open-leaf";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import "@/lib/theme-applier";
import "@/index.css";

// Only the harness owns these controls: they model host-driven pane changes,
// never replace the pointer/keyboard gestures that open or dismiss primitives.
declare global {
  interface Window {
    primitiveGate: {
      focus: (value: boolean) => void;
      visible: (value: boolean) => void;
      conceal: (value: boolean) => void;
      focusEvents: string[];
      ownerClose: () => void;
      toast: () => void;
      closeNested: () => void;
      registrySize: () => number;
      cancelNestedClose: (value: boolean) => void;
      openUnrelated: () => void;
      unmountNested: () => void;
      showNestedTooltip: () => void;
      concealNested: (value: boolean) => void;
      escapeOwnedElsewhere: (within: ReadonlyArray<Element | null>) => boolean;
      command: CommandGateApi;
    };
  }
}
// `mode==="command"` fixture components patch these in from their own
// effects (mirrors the retired T02 proof lane's `window.baseProof.highlight`
// pattern). A module-level object rather than a field the shared Fixture
// component's own mount effect assigns: that effect replaces
// `window.primitiveGate` wholesale, and child effects run BEFORE a parent's
// on mount, so a child-owned key would be wiped by the parent's later,
// same-commit assignment. Referencing this stable object instead of copying
// it sidesteps the ordering hazard entirely.
interface CommandGateApi {
  setHighlight: (palette: string, key: string) => void;
  removeRow: (palette: string, key: string) => void;
  toggleDisabled: (palette: string, key: string) => void;
  reorder: (palette: string, keys: ReadonlyArray<string>) => void;
  // T08 review R1: reorders a row set owned entirely by a component NESTED
  // under `Command` (its own local `useState`), never by `Command`'s own
  // ancestor-level fixture state - so this, unlike `reorder` above, never
  // causes `Command` itself to re-render. Only `Command`'s own
  // `MutationObserver` (watching `listRef.current` for DOM mutations
  // regardless of cause) can pick this up.
  nestedReorder: (keys: ReadonlyArray<string>) => void;
}
interface CommandPaletteGateHandlers {
  readonly setHighlight: (key: string) => void;
  readonly removeRow: (key: string) => void;
  readonly toggleDisabled: (key: string) => void;
  readonly reorder: (keys: ReadonlyArray<string>) => void;
}
// Keyed by palette name rather than one shared per-method slot: several
// CommandBehaviorFixture instances mount as siblings (never nested), so
// mount-effect order across them is unspecified beyond "before paint" - a
// design where each instance's effect directly REPLACES a shared function
// would leave only the last-mounted instance's closure reachable, silently
// dropping every call meant for an earlier one. Each instance instead
// registers its own handlers under its own name, and these dispatchers just
// look the palette up.
const commandPaletteRegistry = new Map<string, CommandPaletteGateHandlers>();
// Single slot, not keyed by name like `commandPaletteRegistry` above: only
// one `NestedLocalReorderRows` instance exists in this fixture, and its own
// reorder path is the whole point under test (see `CommandGateApi.nestedReorder`).
let nestedReorderHandler: ((keys: ReadonlyArray<string>) => void) | undefined;
const commandGateApi: CommandGateApi = {
  setHighlight: (palette, key) =>
    commandPaletteRegistry.get(palette)?.setHighlight(key),
  removeRow: (palette, key) =>
    commandPaletteRegistry.get(palette)?.removeRow(key),
  toggleDisabled: (palette, key) =>
    commandPaletteRegistry.get(palette)?.toggleDisabled(key),
  reorder: (palette, keys) =>
    commandPaletteRegistry.get(palette)?.reorder(keys),
  nestedReorder: (keys) => nestedReorderHandler?.(keys),
};
const params = new URLSearchParams(location.search);
const family = params.get("family") ?? "button";
const state = params.get("state") ?? "default";
const mode = params.get("mode") ?? "visual";
useSettingsStore.setState({
  theme: params.get("theme") === "dark" ? "dark" : "light",
});
const longText =
  "A carefully staged change with a long descriptive label that wraps at the available viewport edge";
const label = state === "long" ? longText : "Project settings";
const trigger = <Button data-gate-trigger>Open settings</Button>;

function MenuCase(props: {
  readonly name: string;
  readonly open: boolean | undefined;
  readonly onOpenChange: ComponentProps<
    typeof Menu.DropdownMenu
  >["onOpenChange"];
  readonly onCloseFocus: (() => void) | undefined;
  // D16: real Tooltip/HoverCard triggers whose own trigger element IS a
  // DropdownMenuItem - hovering one must present its passive preview while
  // the menu stays open, without stealing ownership or blocking ordinary
  // menu dismissal.
  readonly withPassivePreviews: boolean | undefined;
}): ReactNode {
  return (
    <Menu.DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <Menu.DropdownMenuTrigger
        render={<Button data-gate-trigger={props.name}>Open menu</Button>}
      />
      <Menu.DropdownMenuContent
        data-gate-popup={props.name}
        finalFocus={
          props.onCloseFocus
            ? () => {
                props.onCloseFocus?.();
                return true;
              }
            : undefined
        }
      >
        <Menu.DropdownMenuLabel>Workspace</Menu.DropdownMenuLabel>
        <Menu.DropdownMenuItem
          data-gate-item
          disabled={state === "disabled"}
          variant={
            state === "muted" || state === "destructive" ? state : "default"
          }
        >
          {label}
        </Menu.DropdownMenuItem>
        {props.withPassivePreviews ? (
          <>
            <Tooltip.Tooltip>
              <Tooltip.TooltipTrigger
                render={
                  <Menu.DropdownMenuItem data-gate-item="tooltip-preview">
                    Hover for tooltip
                  </Menu.DropdownMenuItem>
                }
              />
              <Tooltip.TooltipContent data-gate-popup="tooltip-in-menu">
                Tooltip preview
              </Tooltip.TooltipContent>
            </Tooltip.Tooltip>
            <Hover.HoverCard
              trigger={
                <Menu.DropdownMenuItem data-gate-item="hover-preview">
                  Hover for preview
                </Menu.DropdownMenuItem>
              }
              content={
                <span data-gate-popup="preview-in-menu">
                  Preview card content
                </span>
              }
              appearance="preview"
              semantics={{ role: "dialog", label: "Preview" }}
              side="bottom"
              align="center"
              sideOffset={4}
              enabled
              open={null}
              onOpenChange={null}
              testId={null}
              className={null}
            />
          </>
        ) : null}
        <Menu.DropdownMenuCheckboxItem
          checked={state === "checked"}
          aria-checked={state === "indeterminate" ? "mixed" : undefined}
        >
          Show details
        </Menu.DropdownMenuCheckboxItem>
        <Menu.DropdownMenuRadioGroup value={state === "radio" ? "one" : "two"}>
          <Menu.DropdownMenuRadioItem value="one">
            First view
          </Menu.DropdownMenuRadioItem>
          <Menu.DropdownMenuRadioItem value="two">
            Second view
          </Menu.DropdownMenuRadioItem>
        </Menu.DropdownMenuRadioGroup>
        <Menu.DropdownMenuSeparator />
        <Menu.DropdownMenuSub>
          <Menu.DropdownMenuSubTrigger data-gate-subtrigger>
            More
          </Menu.DropdownMenuSubTrigger>
          <Menu.DropdownMenuSubContent
            data-gate-subpopup
            layout={state === "submenu-panel" ? "panel" : "menu"}
          >
            <Menu.DropdownMenuItem>Nested action</Menu.DropdownMenuItem>
          </Menu.DropdownMenuSubContent>
        </Menu.DropdownMenuSub>
      </Menu.DropdownMenuContent>
    </Menu.DropdownMenu>
  );
}
function SelectCase(props: {
  readonly name: string;
  readonly open: boolean | undefined;
  readonly onOpenChange: ComponentProps<typeof Select.Select>["onOpenChange"];
  readonly onCloseFocus: (() => void) | undefined;
}): ReactNode {
  return (
    <Select.Select
      open={props.open}
      onOpenChange={props.onOpenChange}
      items={{ one: "First view", two: label, three: "Unavailable" }}
      defaultValue={
        state === "selected" || mode === "conceal" ? "one" : undefined
      }
      disabled={state === "disabled"}
    >
      <Select.SelectTrigger
        data-gate-trigger={props.name}
        size={state === "sm" || state === "xs" ? state : "default"}
      >
        <Select.SelectValue placeholder="Choose a view" />
      </Select.SelectTrigger>
      <Select.SelectContent
        data-gate-popup={props.name}
        finalFocus={
          props.onCloseFocus
            ? () => {
                props.onCloseFocus?.();
                return true;
              }
            : undefined
        }
      >
        <Select.SelectGroup>
          <Select.SelectLabel>Views</Select.SelectLabel>
          <Select.SelectItem value="one">First view</Select.SelectItem>
          <Select.SelectItem value="two">{label}</Select.SelectItem>
          <Select.SelectItem value="three" disabled>
            Unavailable
          </Select.SelectItem>
        </Select.SelectGroup>
      </Select.SelectContent>
    </Select.Select>
  );
}
// Real per-primitive detail unions (each includes the wrapper's own
// non-cancelable PresentationLossDetails member), extracted straight from
// the actual onOpenChange prop types - no hand-duplicated shape.
type MenuChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Menu.DropdownMenu>["onOpenChange"]>
>[1];
type SelectChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Select.Select>["onOpenChange"]>
>[1];
function TooltipCase(): ReactNode {
  return (
    <Tooltip.Tooltip>
      <Tooltip.TooltipTrigger
        render={<Button data-gate-trigger="tooltip">Details</Button>}
      />
      <Tooltip.TooltipContent data-gate-popup="tooltip">
        {label}
      </Tooltip.TooltipContent>
    </Tooltip.Tooltip>
  );
}
// Matches base-ui-proofs.tsx's own passive tooltip (~line 1010): fully
// controlled open={true}, no onOpenChange - nothing can close it, so
// nestedChecks() can prove exclusion against a tooltip that is genuinely,
// unconditionally presented, not one a hover/backdrop race might miss.
function PassiveTooltipCase(): ReactNode {
  return (
    <Tooltip.Tooltip open>
      <Tooltip.TooltipTrigger
        render={<Button data-gate-trigger="tooltip">Details</Button>}
      />
      <Tooltip.TooltipContent data-gate-popup="tooltip">
        {label}
      </Tooltip.TooltipContent>
    </Tooltip.Tooltip>
  );
}
// Real production `@/components/ui/command`, ported off the retired T02
// proof's own row dataset ("tree"/"disabled" + 2 tied "Duplicate" rows +
// r2..r11 "Project N" rows + an exact-match "exact" row) so the browser-lane
// assertions below are the same ones the proof already validated - just
// against the shipped component instead of a throwaway fixture. The toy
// ArrowRight/ArrowLeft "tree expand" feature the proof bolted on is dropped:
// that was proof-only scaffolding, not a real Command feature (the real
// per-Command file-tree store is exercised separately, by the opener
// sub-page cases, not here).
interface CommandFixtureRow {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly disabled?: boolean;
}
const COMMAND_FIXTURE_ROWS: ReadonlyArray<CommandFixtureRow> = [
  { key: "tree", label: "Parent", group: "tree" },
  { key: "disabled-row", label: "Disabled", group: "tree", disabled: true },
  { key: "r0", label: "Duplicate", group: "projects" },
  { key: "r1", label: "Duplicate", group: "projects" },
  ...Array.from({ length: 10 }, (_, index) => ({
    key: `r${index + 2}`,
    label: `Project ${index + 2}`,
    group: "projects",
  })),
  { key: "exact", label: "Project", group: "best" },
];
const COMMAND_DYNAMIC_ROWS: ReadonlyArray<CommandFixtureRow> = [
  { key: "a", label: "Row A", group: "dyn" },
  { key: "b", label: "Row B", group: "dyn" },
  { key: "c", label: "Row C", group: "dyn" },
  { key: "d", label: "Row D", group: "dyn" },
];
// Disabled at BOTH array endpoints - Home/End must land on the nearest
// ENABLED row, never clamp to index 0 / length-1 regardless of that row's
// disabled state. Mirrors the unit-level
// "Home/End skip disabled rows even at the array's own endpoints" case in
// command-navigation.test.tsx; this ports the same shape into the real
// browser lane.
const COMMAND_DISABLED_ENDPOINTS_ROWS: ReadonlyArray<CommandFixtureRow> = [
  { key: "zero", label: "Zero", group: "endpoints", disabled: true },
  { key: "one", label: "One", group: "endpoints" },
  { key: "two", label: "Two", group: "endpoints" },
  { key: "three", label: "Three", group: "endpoints" },
  { key: "four", label: "Four", group: "endpoints", disabled: true },
];
// T08 review R2: 3 groups, the middle one entirely disabled - Alt+ArrowUp/Down
// group-hop must skip a hidden/disabled-only group, always land on the FIRST
// enabled row of the target group (never the row nearest the current one),
// and fall back to an ordinary single step at a group boundary. `enabled`
// (skipping "skip1"/"skip2") is [a, b, c, d]: an Alt-hop from "a" must reach
// "c" directly, skipping "b" too - the one thing that tells a group-hop apart
// from plain/Ctrl-remapped ArrowDown, which would land on "b".
const COMMAND_CHORD_ROWS: ReadonlyArray<CommandFixtureRow> = [
  { key: "a", label: "Alpha", group: "g1" },
  { key: "b", label: "Bravo", group: "g1" },
  { key: "skip1", label: "Skip One", group: "g2", disabled: true },
  { key: "skip2", label: "Skip Two", group: "g2", disabled: true },
  { key: "c", label: "Charlie", group: "g3" },
  { key: "d", label: "Delta", group: "g3" },
];
// T08 review R1: a nested-consumer-owned reorder. Same shared label prefix so
// a query ties all three under the real scorer (`compareSource` is the only
// tiebreaker) - the case the review's own "tied results reordered while a
// query remains active" probe covers, but here the reorder is driven by a
// component NESTED under `Command`, not the top-level fixture (see
// `NestedLocalReorderRows` below).
const COMMAND_NESTED_ROWS: ReadonlyArray<CommandFixtureRow> = [
  { key: "n1", label: "Nested One", group: "nested" },
  { key: "n2", label: "Nested Two", group: "nested" },
  { key: "n3", label: "Nested Three", group: "nested" },
];
// Owns ITS OWN local `useState`, a sibling of `CommandBehaviorFixture`'s own
// rows state, not a descendant of it. Reordering here re-renders only this
// component and its own subtree - `Command` itself is never re-invoked, so
// its render-time `sourcePositions` state and `useLayoutEffect` (the one that
// runs "after every commit" - of `Command`, not of any arbitrary descendant)
// never get a chance to run from this trigger. Only `Command`'s
// `MutationObserver`, watching `listRef.current` for DOM mutations regardless
// of which component's render caused them, can observe this and re-derive
// order/ranking. Proves the observer path exists and is load-bearing, not
// just the render-time fix.
function NestedLocalReorderRows(props: {
  readonly rows: ReadonlyArray<CommandFixtureRow>;
}): ReactNode {
  const { rows: initialRows } = props;
  const [rows, setRows] = useState(initialRows);
  useEffect(() => {
    nestedReorderHandler = (keys) =>
      flushSync(() =>
        setRows((current) =>
          keys
            .map((key) => current.find((row) => row.key === key))
            .filter((row): row is CommandFixtureRow => row !== undefined),
        ),
      );
    return () => {
      nestedReorderHandler = undefined;
    };
  }, []);
  return (
    <>
      {rows.map((row) => (
        <Command.CommandItem
          key={row.key}
          itemKey={row.key}
          searchText={row.label}
        >
          {row.label}
        </Command.CommandItem>
      ))}
    </>
  );
}
function CommandNestedReorderFixture(): ReactNode {
  return (
    <Command.Command data-gate-palette="nested">
      <Command.CommandInput aria-label="nested" placeholder="nested" />
      <Command.CommandList>
        <Command.CommandGroup heading="nested">
          <NestedLocalReorderRows rows={COMMAND_NESTED_ROWS} />
        </Command.CommandGroup>
      </Command.CommandList>
    </Command.Command>
  );
}
function CommandBehaviorFixture(props: {
  readonly name: string;
  readonly rows: ReadonlyArray<CommandFixtureRow>;
  readonly shouldFilter?: boolean;
  // T08 review R2 collision audit: lets a case mount a Command instance whose
  // consumer callback preventDefault()s unconditionally, proving Command's
  // own chord handling honors `event.defaultPrevented` (checked right after
  // the consumer callback runs, before any navigation) rather than always
  // acting first.
  readonly onKeyDown?: ComponentProps<typeof Command.Command>["onKeyDown"];
}): ReactNode {
  const { name, rows: initialRows, shouldFilter, onKeyDown } = props;
  const [rows, setRows] = useState(initialRows);
  const [highlightedValue, setHighlightedValue] = useState("");
  const [picked, setPicked] = useState("");
  useEffect(() => {
    commandPaletteRegistry.set(name, {
      setHighlight: (key) => flushSync(() => setHighlightedValue(key)),
      removeRow: (key) =>
        flushSync(() =>
          setRows((current) => current.filter((row) => row.key !== key)),
        ),
      toggleDisabled: (key) =>
        flushSync(() =>
          setRows((current) =>
            current.map((row) =>
              row.key === key ? { ...row, disabled: !row.disabled } : row,
            ),
          ),
        ),
      reorder: (keys) =>
        flushSync(() =>
          setRows((current) =>
            keys
              .map((key) => current.find((row) => row.key === key))
              .filter((row): row is CommandFixtureRow => row !== undefined),
          ),
        ),
    });
    return () => {
      commandPaletteRegistry.delete(name);
    };
  }, [name]);
  const groups = [...new Set(rows.map((row) => row.group))];
  return (
    <Command.Command
      data-gate-palette={name}
      highlightedValue={highlightedValue}
      onHighlightChange={setHighlightedValue}
      shouldFilter={shouldFilter}
      onKeyDown={onKeyDown}
    >
      <Command.CommandInput aria-label={name} placeholder={name} />
      <Command.CommandList>
        <Command.CommandEmpty>No results</Command.CommandEmpty>
        {groups.map((group) => (
          <Command.CommandGroup key={group} heading={group}>
            {rows
              .filter((row) => row.group === group)
              .map((row) => (
                <Command.CommandItem
                  key={row.key}
                  itemKey={row.key}
                  searchText={row.label}
                  disabled={row.disabled}
                  onAction={() => setPicked(row.key)}
                >
                  {row.label}
                </Command.CommandItem>
              ))}
          </Command.CommandGroup>
        ))}
      </Command.CommandList>
      <div hidden data-gate-command-state={name} data-picked={picked} />
    </Command.Command>
  );
}
// Two independent production `<Command>` mounts sharing the SAME real
// `pathTreeRow` tree id, rendered through the actual exported `SubpageView` ->
// `PathSubpageRows` (`palette-cmdk.tsx`) against real `buildPathTreeItems`/
// `openerPathTreeId` output (`path-tree-items.ts`) - not a rebuilt Files-
// opener host-data pipeline (that needs a live host client, workspace search
// RPC and an open-epic Yjs projection, none of which exist in this fixture),
// and not the raw file-tree hooks either. Isolation comes entirely from
// `Command`'s own `useState(createOpenerFileTreeStore)` +
// `OpenerFileTreeContext.Provider` (`command.tsx`); this proves it against
// the REAL consumer of that store. `open:agents` (`AgentSubpageRows`) and
// `open:artifacts` (`ArtifactSubpageRows`) keep their OWN local `useState`
// expand/collapse sets - they never reach the shared file-tree store at all,
// so DATA isolation is trivially true for them by construction and there is
// nothing for a same-tree-id case to prove there. `pathTreeRow` (driving
// `PathSubpageRows`, `files`/`diff` opener sub-pages) is the one real
// consumer this store isolation actually matters for.
//
// Local state does NOT, on its own, prove EVENT isolation though: both
// `AgentSubpageRows` and `ArtifactSubpageRows` handle ArrowLeft/ArrowRight
// via their own `document.addEventListener("keydown", onKeyDown, true)`
// (mirroring `PathSubpageRows`'s own pattern below), and a document-level
// capture listener can fire against every mounted instance regardless of
// which one's local state "owns" the row - two side-by-side instances with
// unscoped listeners would both react to the same keystroke. Read both and
// confirmed each one DOES scope itself the same way `PathSubpageRows` does
// (`ownerMarkerRef.current?.closest('[data-slot="command"]')` compared
// against `event.target.closest('[data-slot="command"]')`, bailing out when
// they differ) - `CommandAgentArtifactScopingFixture` below proves this
// empirically for both surfaces.
const COMMAND_GATE_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};
const COMMAND_GATE_CTX: CommandContext = {
  pathname: "/",
  router: COMMAND_GATE_ROUTER,
  activeTabId: null,
  activeEpicId: null,
  focusedComposerKind: null,
  targetGroupId: null,
};
function commandGatePathTreeLeaf(path: string): PathTreeLeaf {
  return {
    item: openerActionLeaf({
      id: `open:files:${path}`,
      label: path,
      keywords: [path],
      run: () => undefined,
    }),
    path,
    displaySegments: null,
    structuralSegments: null,
    gitStatus: undefined,
  };
}
// Deliberately the SAME treeId for both mounted instances - the point of
// this case is `Command`'s own per-instance store, not
// `openerPathTreeId`'s hostId/workspacePath uniqueness (which would differ
// per real call site and never collide in practice).
const COMMAND_SHARED_PATH_TREE_ID = openerPathTreeId(
  "files",
  "gate-host",
  "/gate-workspace",
);
const COMMAND_TREE_LEAVES: ReadonlyArray<PathTreeLeaf> = [
  commandGatePathTreeLeaf("src/index.ts"),
  commandGatePathTreeLeaf("src/lib/utils.ts"),
  commandGatePathTreeLeaf("README.md"),
];
function commandGateTreeSubpage(title: string): CommandSubpage {
  return {
    id: "open:files:code-root",
    title,
    useItems: () =>
      buildPathTreeItems(COMMAND_SHARED_PATH_TREE_ID, COMMAND_TREE_LEAVES, []),
  };
}
function CommandTreeIsolationFixture(props: {
  readonly name: string;
}): ReactNode {
  return (
    <Command.Command data-gate-palette={props.name}>
      <Command.CommandInput aria-label={props.name} placeholder={props.name} />
      <Command.CommandList>
        <SubpageView
          subpage={commandGateTreeSubpage(props.name)}
          ctx={COMMAND_GATE_CTX}
          onSelect={() => undefined}
        />
      </Command.CommandList>
    </Command.Command>
  );
}
// Two-row trees (one expandable parent + one child) for the Agent/Artifact
// ArrowLeft/Right event-scoping proof - deliberately the SAME nodeId set
// across both mounted instances of a given kind, the same "same tree id,
// two instances" shape the path-tree case above uses, since that is exactly
// the scenario an unscoped document-level listener would leak across.
function commandGateAgentSubpage(title: string): CommandSubpage {
  const items: ReadonlyArray<CommandItem> = [
    {
      ...openerActionLeaf({
        id: "gate-agent-parent",
        label: "Parent agent",
        keywords: [],
        run: () => undefined,
      }),
      agentTreeRow: {
        nodeId: "agent-parent",
        depth: 0,
        ancestorIds: [],
        hasChildren: true,
        interface: "chat",
        activity: "idle",
      },
    },
    {
      ...openerActionLeaf({
        id: "gate-agent-child",
        label: "Child agent",
        keywords: [],
        run: () => undefined,
      }),
      agentTreeRow: {
        nodeId: "agent-child",
        depth: 1,
        ancestorIds: ["agent-parent"],
        hasChildren: false,
        interface: "chat",
        activity: "idle",
      },
    },
  ];
  return { id: "open:agents", title, useItems: () => items };
}
function commandGateArtifactSubpage(title: string): CommandSubpage {
  const items: ReadonlyArray<CommandItem> = [
    {
      ...openerActionLeaf({
        id: "gate-artifact-parent",
        label: "Parent artifact",
        keywords: [],
        run: () => undefined,
      }),
      artifactTreeRow: {
        nodeId: "artifact-parent",
        depth: 0,
        ancestorIds: [],
        hasChildren: true,
        kind: "story",
        status: null,
      },
    },
    {
      ...openerActionLeaf({
        id: "gate-artifact-child",
        label: "Child artifact",
        keywords: [],
        run: () => undefined,
      }),
      artifactTreeRow: {
        nodeId: "artifact-child",
        depth: 1,
        ancestorIds: ["artifact-parent"],
        hasChildren: false,
        kind: "ticket",
        status: null,
      },
    },
  ];
  return { id: "open:artifacts", title, useItems: () => items };
}
function CommandAgentArtifactScopingFixture(props: {
  readonly name: string;
  readonly kind: "agents" | "artifacts";
}): ReactNode {
  const subpage =
    props.kind === "agents"
      ? commandGateAgentSubpage(props.name)
      : commandGateArtifactSubpage(props.name);
  return (
    <Command.Command data-gate-palette={props.name}>
      <Command.CommandInput aria-label={props.name} placeholder={props.name} />
      <Command.CommandList>
        <SubpageView
          subpage={subpage}
          ctx={COMMAND_GATE_CTX}
          onSelect={() => undefined}
        />
      </Command.CommandList>
    </Command.Command>
  );
}
// Real `PinToggle`, composed the same way `command-palette-shell.tsx`'s own
// `GroupBlock` does it: a pinned item leaves its default group entirely and
// reappears as the first row of a separately-mounted "Pinned" group - which
// is a real React-tree move, not just a within-group DOM reorder. Proves
// (or disproves) that the pin button survives that move without losing
// focus; that is the actual shape of the gesture a keyboard user performs.
interface CommandPinFixtureItem {
  readonly id: string;
  readonly label: string;
}
const COMMAND_PIN_FIXTURE_ITEMS: ReadonlyArray<CommandPinFixtureItem> = [
  { id: "alpha", label: "Alpha action" },
  { id: "beta", label: "Beta action" },
  { id: "gamma", label: "Gamma action" },
];
function CommandPinFixture(): ReactNode {
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const [highlightedValue, setHighlightedValue] = useState("");
  // Registered under the same commandPaletteRegistry the other Command
  // fixtures use, so the driver can force a harmless, group-preserving
  // rerender (a controlled `highlightedValue` change) from the outside
  // WITHOUT any DOM interaction that would itself move keyboard focus -
  // isolating whether focus loss is about "any rerender" or specifically
  // the cross-CommandGroup move a pin toggle causes.
  useEffect(() => {
    commandPaletteRegistry.set("pin", {
      setHighlight: (key) => flushSync(() => setHighlightedValue(key)),
      removeRow: () => undefined,
      toggleDisabled: () => undefined,
      reorder: () => undefined,
    });
    return () => {
      commandPaletteRegistry.delete("pin");
    };
  }, []);
  const togglePin = (id: string): void =>
    setPinned((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pinnedItems = COMMAND_PIN_FIXTURE_ITEMS.filter((item) =>
    pinned.has(item.id),
  );
  const restItems = COMMAND_PIN_FIXTURE_ITEMS.filter(
    (item) => !pinned.has(item.id),
  );
  return (
    <Command.Command
      data-gate-palette="pin"
      highlightedValue={highlightedValue}
      onHighlightChange={setHighlightedValue}
    >
      <Command.CommandInput aria-label="pin" placeholder="pin" />
      <Command.CommandList>
        {pinnedItems.length > 0 ? (
          <Command.CommandGroup heading="Pinned">
            {pinnedItems.map((item) => (
              <Command.CommandItem
                key={item.id}
                itemKey={item.id}
                searchText={item.label}
              >
                <span className="truncate">{item.label}</span>
                <PinToggle
                  itemId={item.id}
                  pinned
                  onToggle={() => togglePin(item.id)}
                />
              </Command.CommandItem>
            ))}
          </Command.CommandGroup>
        ) : null}
        <Command.CommandGroup heading="Actions">
          {restItems.map((item) => (
            <Command.CommandItem
              key={item.id}
              itemKey={item.id}
              searchText={item.label}
            >
              <span className="truncate">{item.label}</span>
              <PinToggle
                itemId={item.id}
                pinned={false}
                onToggle={() => togglePin(item.id)}
              />
            </Command.CommandItem>
          ))}
        </Command.CommandGroup>
      </Command.CommandList>
    </Command.Command>
  );
}
interface NestedCaseProps {
  readonly open: boolean | undefined;
  readonly onOpenChange:
    | ((
        value: boolean,
        details: MenuChangeDetails | SelectChangeDetails,
      ) => void)
    | undefined;
}
// Pulled out of the `dialog` case purely to keep its own complexity in
// check - same three branches (select/tooltip/menu), same gating on
// nestedMounted, no behavior change.
function renderNestedCase(
  nestedMounted: boolean,
  nestedProps: NestedCaseProps,
): ReactNode {
  if (!((family === "nested" || mode === "nested") && nestedMounted))
    return null;
  if (["select", "select-in-dialog"].includes(state))
    return (
      <SelectCase name="nested" {...nestedProps} onCloseFocus={undefined} />
    );
  if (state === "tooltip") return <TooltipCase />;
  return (
    <MenuCase
      name="nested"
      {...nestedProps}
      onCloseFocus={undefined}
      withPassivePreviews={undefined}
    />
  );
}
interface OverlayFrame {
  readonly registry: Set<object>;
  readonly backdrop: RefObject<HTMLDivElement | null>;
  readonly guard: (details: {
    reason: string;
    event: Event;
    cancel: () => void;
  }) => void;
}
interface CaseProps {
  readonly open: boolean;
  readonly changeOpen: (value: boolean) => void;
  readonly body: ReactNode;
  readonly onOpenFocus: () => void;
  readonly onCloseFocus: () => void;
  readonly frame: OverlayFrame;
  readonly nestedOpen: boolean;
  readonly setNestedOpen: (value: boolean) => void;
  readonly cancelNestedClose: boolean;
  readonly nestedMounted: boolean;
  readonly nestedTooltipVisible: boolean;
  readonly nestedConcealed: boolean;
}
const cases: Partial<Record<string, (props: CaseProps) => ReactNode>> = {
  button: (): ReactNode => {
    const variants = [
      "default",
      "outline",
      "card-row",
      "secondary",
      "ghost",
      "muted",
      "muted-outline",
      "destructive-ghost",
      "muted-destructive",
      "warning-ghost",
      "success-ghost",
      "info-ghost",
      "destructive",
      "section-label",
      "link",
    ];
    const variant = (
      variants.includes(state) ? state : "default"
    ) as ComponentProps<typeof Button>["variant"];
    const size = (
      state.startsWith("size-") ? state.slice(5) : "default"
    ) as ComponentProps<typeof Button>["size"];
    return (
      <Button
        data-gate-control
        variant={variant}
        size={size}
        disabled={state === "disabled"}
        aria-pressed={state === "pressed" ? true : undefined}
        aria-checked={state === "mixed" ? "mixed" : undefined}
      >
        {state.includes("icon") ? <Plus /> : label}
      </Button>
    );
  },
  badge: (): ReactNode => {
    const smallSize = state === "size-sm" ? "sm" : "default";
    const variants = [
      "default",
      "secondary",
      "destructive",
      "outline",
      "ghost",
      "link",
      "muted",
      "success",
      "warning",
      "info",
    ];
    return (
      <Badge
        data-gate-control
        tabIndex={0}
        variant={
          (variants.includes(state) ? state : "default") as ComponentProps<
            typeof Badge
          >["variant"]
        }
        size={state === "size-xs" ? "xs" : smallSize}
        aria-disabled={state === "disabled"}
      >
        {label}
      </Badge>
    );
  },
  avatar: (): ReactNode => {
    const avatar = (
      <Avatar.Avatar
        size={state === "sm" || state === "lg" ? state : "default"}
      >
        {state === "image" ? (
          <Avatar.AvatarImage
            alt="Test avatar"
            src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23556677'/%3E%3Ccircle cx='20' cy='17' r='9' fill='white'/%3E%3C/svg%3E"
          />
        ) : null}
        <Avatar.AvatarFallback>AB</Avatar.AvatarFallback>
        <Avatar.AvatarBadge />
      </Avatar.Avatar>
    );
    return state === "group" ? (
      <Avatar.AvatarGroup>
        {avatar}
        <Avatar.Avatar>
          <Avatar.AvatarFallback>CD</Avatar.AvatarFallback>
        </Avatar.Avatar>
        <Avatar.AvatarGroupCount>+2</Avatar.AvatarGroupCount>
      </Avatar.AvatarGroup>
    ) : (
      avatar
    );
  },
  "button-group": (): ReactNode => {
    return (
      <ButtonGroup
        orientation={state === "vertical" ? "vertical" : "horizontal"}
      >
        <Button>Previous</Button>
        {state === "select" ? (
          <SelectCase
            name="select"
            open={undefined}
            onOpenChange={undefined}
            onCloseFocus={undefined}
          />
        ) : (
          <Button>Next</Button>
        )}
      </ButtonGroup>
    );
  },
  separator: (): ReactNode => {
    return (
      <div className="flex h-20 w-full items-center gap-4">
        Before
        <Separator
          orientation={state === "vertical" ? "vertical" : "horizontal"}
        />
        After
      </div>
    );
  },
  label: (): ReactNode => {
    return (
      <div className="flex items-center gap-2">
        <Checkbox id="label-control" disabled={state === "disabled"} />
        <Label htmlFor="label-control">Show details</Label>
      </div>
    );
  },
  checkbox: (): ReactNode => {
    return (
      <Checkbox
        data-gate-control
        aria-label="Show details"
        defaultChecked={state === "checked"}
        indeterminate={state === "indeterminate"}
        disabled={state === "disabled"}
      />
    );
  },
  switch: (): ReactNode => {
    return (
      <Switch
        data-gate-control
        aria-label="Show details"
        defaultChecked={state === "checked"}
        disabled={state === "disabled"}
      />
    );
  },
  radio: (): ReactNode => {
    return (
      <Radio.RadioGroup
        defaultValue={state === "checked" ? "one" : "two"}
        disabled={state === "disabled"}
      >
        <Radio.RadioGroupItem
          data-gate-control
          value="one"
          aria-label="First view"
        />
        <Radio.RadioGroupItem value="two" aria-label="Second view" />
      </Radio.RadioGroup>
    );
  },
  slider: (): ReactNode => {
    return (
      <Slider.Slider defaultValue={40} disabled={state === "disabled"}>
        <Slider.SliderTrack size={state === "pill" ? "pill" : "default"}>
          <Slider.SliderRange />
        </Slider.SliderTrack>
        <Slider.SliderThumb
          data-gate-control
          size={state === "pill" ? "pill" : "default"}
          aria-label="Volume"
        />
      </Slider.Slider>
    );
  },
  tabs: (): ReactNode => {
    const scope = state.startsWith("scope");
    const variant = state.startsWith("line") ? "line" : "default";
    const size = state.includes("sm") ? "sm" : "default";
    const index = scope ? Number(state.slice(-1)) : 0;
    const disabledIndex = state === "disabled" ? 1 : -1;
    return (
      <Tabs.Tabs
        defaultValue={String(index)}
        orientation={state === "vertical" ? "vertical" : "horizontal"}
      >
        <Tabs.TabsList
          variant={scope ? "scope" : variant}
          size={scope ? "scope" : size}
          indicatorIndex={index}
        >
          {["All", "Current task", "Current workspace"].map((text, i) => (
            <Tabs.TabsTrigger
              key={text}
              data-gate-control={i === 0 ? "true" : undefined}
              value={String(i)}
              variant={scope ? "scope" : undefined}
              disabled={i === disabledIndex}
            >
              {text}
            </Tabs.TabsTrigger>
          ))}
        </Tabs.TabsList>
        {[0, 1, 2].map((i) => (
          <Tabs.TabsContent key={i} value={String(i)}>
            View {i + 1}
          </Tabs.TabsContent>
        ))}
      </Tabs.Tabs>
    );
  },
  collapsible: (): ReactNode => {
    const variant = state.startsWith("panel") ? "panel" : "default";
    const rootVariant = state.startsWith("card") ? "card" : variant;
    return (
      <Collapsible.Collapsible
        defaultOpen={state.endsWith("open")}
        variant={rootVariant}
      >
        <Collapsible.CollapsibleTrigger
          data-gate-control
          variant={state === "quiet" ? "quiet" : variant}
        >
          Show details
        </Collapsible.CollapsibleTrigger>
        <Collapsible.CollapsibleContent>
          Changes staged in the current workspace.
        </Collapsible.CollapsibleContent>
      </Collapsible.Collapsible>
    );
  },
  sidebar: (): ReactNode => {
    return (
      <Sidebar.SidebarProvider defaultOpen={state !== "rail"}>
        <Sidebar.Sidebar collapsible="icon">
          <Sidebar.SidebarContent>
            <Sidebar.SidebarGroup>
              <Sidebar.SidebarMenu>
                {state === "skeleton" ? (
                  <Sidebar.SidebarMenuSkeleton showIcon />
                ) : (
                  <Sidebar.SidebarMenuItem>
                    <Sidebar.SidebarMenuButton tooltip="Workspace">
                      <Plus />
                      <span>Workspace</span>
                    </Sidebar.SidebarMenuButton>
                  </Sidebar.SidebarMenuItem>
                )}
              </Sidebar.SidebarMenu>
            </Sidebar.SidebarGroup>
          </Sidebar.SidebarContent>
        </Sidebar.Sidebar>
        <Sidebar.SidebarTrigger data-gate-trigger="sidebar" />
      </Sidebar.SidebarProvider>
    );
  },
  dialog: ({
    open,
    changeOpen,
    body,
    onOpenFocus,
    onCloseFocus,
    frame,
    nestedOpen,
    setNestedOpen,
    cancelNestedClose,
    nestedMounted,
    nestedTooltipVisible,
    nestedConcealed,
  }): ReactNode => {
    const isFramed = family === "frame" || state === "menu-in-frame";
    // Only nestedChecks()'s own family==="frame" path is controlled (lets
    // the driver force a synchronous close via `closeNested()`); the older
    // family==="nested" states stay fully uncontrolled, unchanged.
    const nestedControlled = family === "frame";
    const nestedProps = nestedControlled
      ? {
          open: nestedOpen,
          // The owner's own onOpenChange can veto a close (Base's `cancel`
          // lever) - `cancelNestedClose` lets the driver arm that veto and
          // prove both the child and the frame survive a press that would
          // otherwise have closed the child. PresentationLossDetails carries
          // no `cancel` at all, so `"cancel" in details` excludes it by
          // construction - that close must never be vetoed.
          onOpenChange: (
            value: boolean,
            details: MenuChangeDetails | SelectChangeDetails,
          ) => {
            if (!value && cancelNestedClose && "cancel" in details) {
              details.cancel();
              return;
            }
            setNestedOpen(value);
          },
        }
      : { open: undefined, onOpenChange: undefined };
    const nested = renderNestedCase(nestedMounted, nestedProps);
    const titleSize = state === "title-lg" ? "lg" : "default";
    return (
      <Dialog.Dialog
        open={open}
        paneAware={!isFramed}
        onOpenChange={(next, details) => {
          // A nonmodal frame never raises Base's own barrier (matching the
          // real production case this models, epic-migration-modal.tsx: it
          // is deliberately never dismissible by outside press/Escape - only
          // its own explicit close control, which calls `changeOpen`
          // directly and never goes through this callback at all).
          if (state === "nonmodal" && !next) {
            details.cancel();
            return;
          }
          if (isFramed) {
            frame.guard(details);
            if (details.isCanceled) return;
          }
          changeOpen(next);
        }}
        modal={state !== "nonmodal"}
      >
        <Dialog.DialogTrigger render={trigger} />
        {isFramed ? (
          <OverlayFrameContext.Provider value={frame.registry}>
            <PromotableModalFrame
              title="Workspace settings"
              icon={<Plus />}
              contentClassName="w-full max-w-[min(90vw,40rem)]"
              dataAttributes={{ "data-gate-popup": "outer" }}
              promoteAriaLabel="Open as tab"
              promoteTestId="promote"
              closeTestId="close"
              onPromote={() => undefined}
              onClose={() => changeOpen(false)}
              backdropRef={frame.backdrop}
              initialFocus={mode === "visual" ? undefined : true}
            >
              <div className="flex w-full flex-col">
                {body}
                {family === "frame" ? (
                  <PortalConcealmentBoundary concealed={nestedConcealed}>
                    {nested}
                  </PortalConcealmentBoundary>
                ) : (
                  nested
                )}
                {/* A passive tooltip coexisting in the same frame - it never
                    registers in OverlayFrameContext (tooltip.tsx doesn't use
                    useOverlayFrameRegistration), so it must not be able to
                    claim or block the nested child's own dismissal. Opt-in
                    only, so every other case's DOM shape is unchanged. */}
                {nestedTooltipVisible ? <PassiveTooltipCase /> : null}
              </div>
            </PromotableModalFrame>
          </OverlayFrameContext.Provider>
        ) : (
          <Dialog.DialogContent
            data-gate-popup="outer"
            layout={state === "banded" ? "banded" : "padded"}
            initialFocus={
              mode === "visual"
                ? undefined
                : () => {
                    onOpenFocus();
                    return true;
                  }
            }
            finalFocus={
              mode === "visual"
                ? undefined
                : () => {
                    onCloseFocus();
                    return true;
                  }
            }
          >
            <Dialog.DialogHeader>
              <Dialog.DialogTitle
                size={state === "title-sm" ? "sm" : titleSize}
              >
                Workspace settings
              </Dialog.DialogTitle>
              <Dialog.DialogDescription>{label}</Dialog.DialogDescription>
            </Dialog.DialogHeader>
            {body}
            {nested}
            <Dialog.DialogFooter>
              <Button onClick={() => changeOpen(false)}>Done</Button>
            </Dialog.DialogFooter>
          </Dialog.DialogContent>
        )}
      </Dialog.Dialog>
    );
  },
  sheet: ({ open, changeOpen, body }): ReactNode => {
    return (
      <Sheet.Sheet open={open} onOpenChange={changeOpen}>
        <Sheet.SheetTrigger render={trigger} />
        <Sheet.SheetContent
          data-gate-popup="outer"
          side={
            state === "left" || state === "top" || state === "bottom"
              ? state
              : "right"
          }
        >
          <Sheet.SheetHeader>
            <Sheet.SheetTitle>Workspace settings</Sheet.SheetTitle>
            <Sheet.SheetDescription>{label}</Sheet.SheetDescription>
          </Sheet.SheetHeader>
          {body}
          {family === "nested" ? (
            <Popover.Popover>
              <Popover.PopoverTrigger
                render={<Button data-gate-trigger="nested">More</Button>}
              />
              <Popover.PopoverContent data-gate-popup="nested">
                Nested settings
              </Popover.PopoverContent>
            </Popover.Popover>
          ) : null}
        </Sheet.SheetContent>
      </Sheet.Sheet>
    );
  },
  drawer: ({ open, changeOpen, body }): ReactNode => {
    return (
      <Drawer.Drawer
        open={open}
        onOpenChange={changeOpen}
        swipeDirection="down"
      >
        <Drawer.DrawerTrigger render={trigger} />
        <Drawer.DrawerContent data-gate-popup="outer" className="max-h-[85dvh]">
          <Drawer.DrawerHeader>
            <Drawer.DrawerTitle>Workspace settings</Drawer.DrawerTitle>
            <Drawer.DrawerDescription>{label}</Drawer.DrawerDescription>
          </Drawer.DrawerHeader>
          <div className="overflow-auto pb-safe-bottom">
            {body}
            {state === "long" ? (
              <div
                data-base-ui-swipe-ignore
                className="max-h-[40dvh] overflow-auto"
              >
                {Array.from({ length: 20 }, (_, i) => (
                  <p key={i}>File {i + 1}: staged changes</p>
                ))}
              </div>
            ) : null}
          </div>
        </Drawer.DrawerContent>
      </Drawer.Drawer>
    );
  },
  popover: ({
    open,
    changeOpen,
    body,
    onOpenFocus,
    onCloseFocus,
  }): ReactNode => {
    return (
      <Popover.Popover open={open} onOpenChange={changeOpen}>
        <Popover.PopoverTrigger render={trigger} />
        <Popover.PopoverContent
          data-gate-popup="outer"
          layout={state === "bare" || state === "panel" ? state : "padded"}
          initialFocus={
            mode === "visual"
              ? undefined
              : () => {
                  onOpenFocus();
                  return true;
                }
          }
          finalFocus={
            mode === "visual"
              ? undefined
              : () => {
                  onCloseFocus();
                  return true;
                }
          }
        >
          {label}
          {body}
          {family === "nested" ? <TooltipCase /> : null}
        </Popover.PopoverContent>
      </Popover.Popover>
    );
  },
  tooltip: (): ReactNode => {
    return <TooltipCase />;
  },
  "hover-card": (): ReactNode => {
    return (
      <Hover.HoverCard
        trigger={<Button data-gate-trigger="hover">Preview</Button>}
        content={<span data-gate-popup="hover">{label}</span>}
        appearance={state === "tooltip" ? "tooltip" : "preview"}
        semantics={{ role: "dialog", label: "Preview" }}
        side="bottom"
        align="center"
        sideOffset={4}
        enabled
        open={null}
        onOpenChange={null}
        testId={null}
        className={null}
      />
    );
  },
  "dropdown-menu": ({ open, changeOpen, onCloseFocus }): ReactNode => {
    return (
      <MenuCase
        name="outer"
        open={open}
        onOpenChange={changeOpen}
        onCloseFocus={onCloseFocus}
        withPassivePreviews={state === "passive-previews"}
      />
    );
  },
  "context-menu": ({ open, changeOpen, onCloseFocus }): ReactNode => {
    return (
      <Context.ContextMenu
        open={mode === "conceal" && state === "uncontrolled" ? undefined : open}
        onOpenChange={changeOpen}
      >
        <Context.ContextMenuTrigger data-gate-trigger="context">
          <Button>Right-click for actions</Button>
        </Context.ContextMenuTrigger>
        <Context.ContextMenuContent
          data-gate-popup="outer"
          finalFocus={
            mode === "visual"
              ? undefined
              : () => {
                  onCloseFocus();
                  return true;
                }
          }
        >
          <Context.ContextMenuItem
            variant={state === "destructive" ? "destructive" : "default"}
            disabled={state === "disabled"}
          >
            {label}
          </Context.ContextMenuItem>
          <Context.ContextMenuCheckboxItem checked={state === "checked"}>
            Show details
          </Context.ContextMenuCheckboxItem>
          <Context.ContextMenuSub>
            <Context.ContextMenuSubTrigger data-gate-subtrigger>
              More
            </Context.ContextMenuSubTrigger>
            <Context.ContextMenuSubContent
              data-gate-subpopup
              layout={state === "submenu-panel" ? "panel" : "menu"}
            >
              <Context.ContextMenuItem>Nested action</Context.ContextMenuItem>
            </Context.ContextMenuSubContent>
          </Context.ContextMenuSub>
        </Context.ContextMenuContent>
      </Context.ContextMenu>
    );
  },
  menubar: ({ open, changeOpen }): ReactNode => {
    // Uncontrolled for the pixel/visual fixture (unchanged rendering, no new
    // wiring risk); controlled only in behavior mode, so toastChecks()'s
    // owner counters (data-gate-state's data-open) are meaningful for it too.
    const menuProps =
      mode === "visual" ? {} : { open, onOpenChange: changeOpen };
    return (
      <Menubar.Menubar>
        <Menubar.MenubarMenu {...menuProps}>
          <Menubar.MenubarTrigger data-gate-trigger>
            Workspace
          </Menubar.MenubarTrigger>
          <Menubar.MenubarContent data-gate-popup="outer">
            <Menubar.MenubarItem disabled={state === "disabled"}>
              {label}
            </Menubar.MenubarItem>
            <Menubar.MenubarSub>
              <Menubar.MenubarSubTrigger data-gate-subtrigger>
                More
              </Menubar.MenubarSubTrigger>
              <Menubar.MenubarSubContent data-gate-subpopup>
                <Menubar.MenubarItem>Nested action</Menubar.MenubarItem>
              </Menubar.MenubarSubContent>
            </Menubar.MenubarSub>
          </Menubar.MenubarContent>
        </Menubar.MenubarMenu>
      </Menubar.Menubar>
    );
  },
  select: ({ open, changeOpen, onCloseFocus }): ReactNode => {
    return (
      <SelectCase
        name="outer"
        open={mode === "conceal" && state === "uncontrolled" ? undefined : open}
        onOpenChange={changeOpen}
        onCloseFocus={onCloseFocus}
      />
    );
  },
  command: (): ReactNode => {
    // mode==="command" is strictly additive, new-value-gated behavior
    // fixtures for the browser lane; the 6 static visual states above
    // (mode==="visual", the default) are untouched byte-for-byte.
    if (mode === "command")
      return (
        <div className="flex flex-col gap-4">
          <CommandBehaviorFixture name="one" rows={COMMAND_FIXTURE_ROWS} />
          <CommandBehaviorFixture name="two" rows={COMMAND_FIXTURE_ROWS} />
          <CommandBehaviorFixture
            name="nofilter"
            rows={COMMAND_FIXTURE_ROWS}
            shouldFilter={false}
          />
          <CommandBehaviorFixture name="dyn" rows={COMMAND_DYNAMIC_ROWS} />
          <CommandBehaviorFixture
            name="endpoints"
            rows={COMMAND_DISABLED_ENDPOINTS_ROWS}
          />
          <CommandBehaviorFixture name="chords" rows={COMMAND_CHORD_ROWS} />
          <CommandBehaviorFixture
            name="guarded"
            rows={COMMAND_CHORD_ROWS}
            onKeyDown={(event) => event.preventDefault()}
          />
          <CommandNestedReorderFixture />
          <CommandTreeIsolationFixture name="tree-one" />
          <CommandTreeIsolationFixture name="tree-two" />
          <CommandAgentArtifactScopingFixture name="agents-one" kind="agents" />
          <CommandAgentArtifactScopingFixture name="agents-two" kind="agents" />
          <CommandAgentArtifactScopingFixture
            name="artifacts-one"
            kind="artifacts"
          />
          <CommandAgentArtifactScopingFixture
            name="artifacts-two"
            kind="artifacts"
          />
          <CommandPinFixture />
        </div>
      );
    return (
      <Command.Command
        variant={state === "embedded" ? "embedded" : "standalone"}
        selection={state === "flat" ? "flat" : "lifted"}
      >
        <Command.CommandInput
          placeholder="Search actions"
          value={state === "empty" ? "zzzz" : undefined}
        />
        <Command.CommandList>
          <Command.CommandEmpty>No results</Command.CommandEmpty>
          <Command.CommandGroup heading="Workspace">
            <Command.CommandItem
              itemKey="settings"
              disabled={state === "disabled"}
              data-checked={state === "checked"}
            >
              Settings
            </Command.CommandItem>
            <Command.CommandItem itemKey="files">Files</Command.CommandItem>
          </Command.CommandGroup>
        </Command.CommandList>
      </Command.Command>
    );
  },
  // D16: Command mounted inside Dialog/Popover, proving Base's real DEFAULT
  // focus behavior (focus-first-tabbable on open, restore-to-trigger on
  // close) against the Command search input - never the callback-forced
  // `initialFocus`/`finalFocus` the `dialog`/`popover` cases use for their
  // own onOpenFocus/onCloseFocus checks. Deliberately its own top-level
  // family, not a `dialog`/`popover` state: reusing those would either give
  // up the real-default-focus assertion (their non-visual branches force
  // focus via a callback) or require branching their existing, already
  // pixel-gated bodies.
  "command-in-dialog": ({ open, changeOpen }): ReactNode => (
    <Dialog.Dialog open={open} onOpenChange={changeOpen}>
      <Dialog.DialogTrigger render={trigger} />
      <Dialog.DialogContent data-gate-popup="outer">
        <Dialog.DialogHeader>
          <Dialog.DialogTitle>Command in dialog</Dialog.DialogTitle>
          <Dialog.DialogDescription>{label}</Dialog.DialogDescription>
        </Dialog.DialogHeader>
        <CommandBehaviorFixture name="one" rows={COMMAND_FIXTURE_ROWS} />
      </Dialog.DialogContent>
    </Dialog.Dialog>
  ),
  "command-in-popover": ({ open, changeOpen }): ReactNode => (
    <Popover.Popover open={open} onOpenChange={changeOpen}>
      <Popover.PopoverTrigger render={trigger} />
      <Popover.PopoverContent data-gate-popup="outer" layout="bare">
        <CommandBehaviorFixture name="one" rows={COMMAND_FIXTURE_ROWS} />
      </Popover.PopoverContent>
    </Popover.Popover>
  ),
};
export function Fixture(): ReactNode {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(true);
  const [visible, setVisible] = useState(true);
  const [concealed, setConcealed] = useState(false);
  const [draft, setDraft] = useState("Staged value");
  const [changes, setChanges] = useState(0);
  const [actions, setActions] = useState(0);
  const [closeFocus, setCloseFocus] = useState(0);
  const [openFocus, setOpenFocus] = useState(0);
  // Controlled state for the "frame" family's nested menu/select child only
  // (mode==="nested" && family==="frame", used by nestedChecks()) - lets the
  // driver force a synchronous, flushSync-committed close/reopen of just the
  // child, independent of any real gesture. The older family==="nested"
  // (menu-in-dialog, select-in-dialog, ...) path stays fully uncontrolled.
  const [nestedOpen, setNestedOpen] = useState(false);
  // Arms the nested child's onOpenChange cancel lever - see `dialog`'s
  // `nestedProps.onOpenChange` above.
  const [cancelNestedClose, setCancelNestedClose] = useState(false);
  // A sibling overlay rendered outside OverlayFrameContext.Provider (see the
  // Fixture return below) - proves an overlay unrelated to this frame never
  // gets counted as one of its children.
  const [unrelatedOpen, setUnrelatedOpen] = useState(false);
  // Removes the nested child from the tree entirely, so its registration
  // releases via unmount cleanup rather than a controlled open=false.
  const [nestedMounted, setNestedMounted] = useState(true);
  // Opt-in only (default false) - every other nestedChecks() case must keep
  // its exact existing DOM shape.
  const [nestedTooltipVisible, setNestedTooltipVisible] = useState(false);
  // Wraps ONLY the nested child (never the tooltip) in the real production
  // PortalConcealmentBoundary - concealing it flips the wrapper's own
  // computed `open` (logical && present) to false, closing and deregistering
  // it, without touching `nestedOpen` (the logical/controlled state) itself.
  const [nestedConcealed, setNestedConcealed] = useState(false);
  // Only the "dialog" case (family=frame / state=menu-in-frame) uses this,
  // but it must be called unconditionally here rather than from inside the
  // `cases` record - those are plain functions, not components, so a hook
  // called from one trips rules-of-hooks even though the call order is
  // stable (one fixed family/state per page load).
  const frame = useOverlayFrame();
  const changeOpen = (value: boolean): void => {
    setOpen(value);
    setChanges((count) => count + 1);
  };
  useEffect(() => {
    const showToast = (): void => {
      toast(
        <Button
          data-gate-toast-action
          onClick={() => setActions((count) => count + 1)}
        >
          Apply update
        </Button>,
        { id: "gate-toast", duration: Infinity, description: null },
      );
    };
    const focusEvents: string[] = [];
    const recordFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Element)
        focusEvents.push(target.matches("[data-gate-outside]") ? "B" : "A");
    };
    document.addEventListener("focusin", recordFocus);
    const transfer = (commit: () => void): void => {
      focusEvents.length = 0;
      // One host switch transaction. Record the commit and every later focus
      // event; never repair focus after waiting for library cleanup.
      flushSync(commit);
      document.querySelector<HTMLElement>("[data-gate-outside]")?.focus();
    };
    window.primitiveGate = {
      // The true branch is synchronous too: an interrupted-close driver
      // script restores presentation and clicks the trigger to reopen it in
      // the SAME task (never waiting out the exit animation), which only
      // sees a committed `paneFocused`/`visible` value if this commits before
      // that click's `useClosingOverlay` gate reads it.
      focus: (value) =>
        value
          ? flushSync(() => setFocused(true))
          : transfer(() => setFocused(false)),
      visible: (value) =>
        value
          ? flushSync(() => setVisible(true))
          : transfer(() => setVisible(false)),
      conceal: setConcealed,
      focusEvents,
      ownerClose: () => setOpen(false),
      toast: showToast,
      // Forces a synchronous, flushSync-committed close of the "frame"
      // family's nested menu/select child (mode==="nested" &&
      // family==="frame" only - see `nestedOpen` above). By the time this
      // returns, `useOverlayFrameRegistration`'s cleanup has already run
      // (flushSync flushes layout effects too), so `registrySize()` read
      // right after is a genuine post-close value, not an inferred one.
      closeNested: () => flushSync(() => setNestedOpen(false)),
      registrySize: () => frame.registry.size,
      cancelNestedClose: (value) =>
        flushSync(() => setCancelNestedClose(value)),
      openUnrelated: () => flushSync(() => setUnrelatedOpen(true)),
      unmountNested: () => flushSync(() => setNestedMounted(false)),
      showNestedTooltip: () => flushSync(() => setNestedTooltipVisible(true)),
      concealNested: (value) => flushSync(() => setNestedConcealed(value)),
      escapeOwnedElsewhere,
      command: commandGateApi,
    };
    return () => document.removeEventListener("focusin", recordFocus);
    // `frame.registry` (the Set) is stable across renders (useOverlayFrame's
    // own useState), even though `frame` itself is a fresh object each call -
    // depend on the stable Set, not a snapshotted `.size` that would go stale.
  }, [frame.registry]);
  const input = (
    <Input
      data-gate-input
      aria-label="Staged value"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
  // state="textarea" is a dedicated, unused-elsewhere value driven only by
  // defaultFocusChecks() - every other state keeps this identical to before,
  // so no existing pixel baseline is affected.
  const focusTarget =
    state === "textarea" ? (
      <Textarea
        data-gate-textarea
        aria-label="Staged value"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    ) : (
      input
    );
  const body = (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      {focusTarget}
      <Button data-gate-body>Ordinary dialog control</Button>
    </div>
  );
  const nestedFamilies: Record<string, string> = {
    "menu-in-dialog": "dialog",
    "select-in-dialog": "dialog",
    "menu-in-frame": "dialog",
    "popover-in-sheet": "sheet",
    "tooltip-in-popover": "popover",
  };
  let caseFamily = family;
  if (family === "frame") caseFamily = "dialog";
  if (family === "nested") caseFamily = nestedFamilies[state];
  const render = cases[caseFamily];
  if (!render) throw new Error("Unknown gate family: " + family);
  const content = render({
    open,
    changeOpen,
    body,
    onOpenFocus: () => setOpenFocus((count) => count + 1),
    onCloseFocus: () => setCloseFocus((count) => count + 1),
    frame,
    nestedOpen,
    setNestedOpen,
    cancelNestedClose,
    nestedMounted,
    nestedTooltipVisible,
    nestedConcealed,
  });
  if (content === undefined || content === null)
    throw new Error("Empty gate case: " + family + "/" + state);
  return (
    <Tooltip.TooltipProvider>
      <div
        data-gate-state
        data-open={String(open)}
        data-focused={String(focused)}
        data-visible={String(visible)}
        data-concealed={String(concealed)}
        data-changes={changes}
        data-actions={actions}
        data-draft={draft}
        data-open-focus={openFocus}
        data-close-focus={closeFocus}
      />
      <SurfacePresentationBoundary visible={visible} focused={focused}>
        <PortalConcealmentProvider value={concealed}>
          <main
            data-gate-stage={state === "edge" ? "edge" : "center"}
            hidden={!visible}
          >
            <div data-gate-inline>
              {mode === "conceal" ? (
                <Input
                  data-gate-owner-input
                  aria-label="Owner draft"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              ) : null}
              {content}
              {family === "frame" ? (
                <Popover.Popover
                  open={unrelatedOpen}
                  // Independent, controlled, and deliberately never closed by
                  // an ordinary press - it must stay open and presented for
                  // the whole test, so "excluded from frame ownership" is
                  // proven against a genuinely open sibling, not one that
                  // already closed itself on the same outside click.
                  onOpenChange={(next, details) => {
                    if (!next) {
                      details.cancel();
                      return;
                    }
                    setUnrelatedOpen(next);
                  }}
                >
                  <Popover.PopoverTrigger
                    render={
                      <Button data-gate-unrelated-trigger>Unrelated</Button>
                    }
                  />
                  <Popover.PopoverContent
                    data-gate-unrelated
                    initialFocus={false}
                  >
                    Unrelated overlay
                  </Popover.PopoverContent>
                </Popover.Popover>
              ) : null}
            </div>
          </main>
        </PortalConcealmentProvider>
      </SurfacePresentationBoundary>
      <Button data-gate-outside>Ordinary outside control</Button>
      <div data-gate-scroll className="h-20 overflow-auto">
        <div className="h-[200vh]">Pane B scroll area</div>
      </div>
      {mode === "conceal" ? (
        <div className="h-[200vh]" data-gate-document-space />
      ) : null}
      {mode === "toast" ? <Toaster /> : null}
    </Tooltip.TooltipProvider>
  );
}
const root = document.getElementById("root");
if (root === null) throw new Error("Gate root missing");
createRoot(root).render(<Fixture />);
