import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  Ellipsis,
  PanelLeft,
  PanelRight,
  PictureInPicture2,
  Redo2,
  Settings2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { cn } from "@/lib/utils";
import { RelayRow } from "@/components/layout-editor/inspector/relay-row";
import { SessionChangesRow } from "@/components/layout-editor/inspector/session-changes";
import type { LayoutDockMode } from "@/stores/layout/layout-editor-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * How the chrome leaves the editor: Done, Discard (the entry snapshot back
 * first), or the full-width page. Ending a session is the door's job, so the
 * caller owns all three. Escape is not one of them: it never closes the editor
 * (audit F5).
 */
export type InspectorExit = "done" | "discard" | "open-settings";

interface InspectorShellProps {
  readonly onExit: (reason: InspectorExit) => void;
  readonly children: ReactNode;
}

const DOCK_MODES: ReadonlyArray<{
  readonly mode: LayoutDockMode;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { mode: "right", label: "Dock right", icon: <PanelRight /> },
  { mode: "left", label: "Dock left", icon: <PanelLeft /> },
  { mode: "float", label: "Float", icon: <PictureInPicture2 /> },
];

/**
 * The inspector's own chrome (L-05): the header (title, the ⋯ menu with the
 * dock modes, Undo/Redo, the split `Done ▾`), the session's change summary,
 * the relay slot and the scrollable body the caller supplies.
 *
 * The dock is its one host. L-03's "one form, two hosts" is about the form,
 * which `Settings > Layout` draws inside its own shell; Undo, Redo, the dock
 * menu and Done are the instrument panel's.
 */
export function InspectorShell(props: InspectorShellProps): ReactNode {
  const { onExit } = props;
  const dockMode = useLayoutEditorStore((state) => state.dockMode);
  const canUndo = useLayoutEditorStore(
    (state) => state.history.past.length > 0,
  );
  const canRedo = useLayoutEditorStore(
    (state) => state.history.future.length > 0,
  );

  return (
    <div
      // Focusable but not a tab stop: the firewall bounces focus that lands on
      // the app column back to here, so the bounce has to land ON it rather
      // than above it (4.4).
      tabIndex={-1}
      data-layout-inspector-shell
      className="flex h-full min-h-0 max-w-full flex-col bg-background outline-none"
    >
      {/* The float mode's drag handle (L-38): `dock-modes.ts` picks a drag up
        here and nowhere else, so the body scrolls rather than moves. */}
      <div
        data-layout-inspector-header
        className={cn(
          "flex h-11 shrink-0 items-center gap-0.5 border-b border-border pr-2.5 pl-3.5",
          // Docked left, this header sits at the window's top-left corner, so
          // it keeps the traffic-light reserve the app column gives up.
          dockMode === "left" &&
            "wco:pl-[max(0.875rem,var(--window-leading-inset))]",
        )}
      >
        <span className="text-ui-sm font-medium tracking-[0.01em]">Layout</span>
        <span className="flex-1" />
        <InspectorMenu
          dockMode={dockMode}
          onOpenSettings={() => {
            onExit("open-settings");
          }}
        />
        <TooltipWrapper
          label="Undo"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => {
              useLayoutEditorStore.getState().undo();
            }}
          >
            <Undo2 />
          </Button>
        </TooltipWrapper>
        <TooltipWrapper
          label="Redo"
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => {
              useLayoutEditorStore.getState().redo();
            }}
          >
            <Redo2 />
          </Button>
        </TooltipWrapper>
        <DoneButton onExit={onExit} />
      </div>
      <SessionChangesRow />
      <RelayRow
        onDone={() => {
          onExit("done");
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </div>
  );
}

/** `⋯`: where the panel sits, and the way to the full-width page. */
function InspectorMenu(props: {
  readonly dockMode: LayoutDockMode;
  readonly onOpenSettings: () => void;
}): ReactNode {
  return (
    <DropdownMenu>
      <TooltipWrapper
        label="Inspector options"
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Inspector options"
            >
              <Ellipsis />
            </Button>
          }
        />
      </TooltipWrapper>
      <DropdownMenuContent align="end" className="w-[min(90vw,13rem)]">
        <DropdownMenuLabel>Inspector</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.dockMode}
          onValueChange={(value) => {
            const entry = DOCK_MODES.find((mode) => mode.mode === value);
            if (entry !== undefined)
              useLayoutEditorStore.getState().setDockMode(entry.mode);
          }}
        >
          {DOCK_MODES.map((entry) => (
            <DropdownMenuRadioItem key={entry.mode} value={entry.mode}>
              {entry.icon}
              {entry.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={props.onOpenSettings}>
          <Settings2 />
          Open Layout settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The split `Done ▾`. Done keeps what the session wrote, because it applied
 * live; the menu holds the one way back, behind a confirm.
 */
function DoneButton(props: {
  readonly onExit: (reason: InspectorExit) => void;
}): ReactNode {
  const { onExit } = props;
  // A boolean the gesture paths maintain, never a selector that serialises the
  // layout triple on every editor-store notification (G1-04).
  const canDiscard = useLayoutEditorStore((state) => state.dirty);
  const [confirming, setConfirming] = useState(false);
  // Done's chord is whatever Close tab is bound to: that binding is what the
  // editor intercepts as Done (`closeLayoutEditorForCloseTabChord`).
  const closeChord = useBindingForAction("tab.close");
  return (
    <>
      <ButtonGroup className="ml-1.5">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            onExit("done");
          }}
        >
          Done
        </Button>
        <ButtonGroupSeparator />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" size="icon-sm" aria-label="More ways out">
                <ChevronDown />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-[min(90vw,15rem)]">
            <DropdownMenuItem
              onClick={() => {
                onExit("done");
              }}
            >
              {/* An empty icon slot, not a check: a check reads as a
                  selected state. It keeps the label on Discard's column. */}
              <span aria-hidden className="size-4 shrink-0" />
              Done
              {closeChord === null ? null : (
                <DropdownMenuShortcut>
                  {formatChordForDisplay(closeChord)}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!canDiscard}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Undo2 />
              Discard session changes…
            </DropdownMenuItem>
            <p className="px-1.5 pb-1 pl-7 text-ui-xs text-muted-foreground">
              Back to your layout from when you opened the editor.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      <ConfirmDestructiveDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Discard session changes?"
        description="Your layout goes back to how it was when you opened the editor, and the editor closes."
        cascadeSummary={null}
        actionLabel="Discard changes"
        isPending={false}
        blockedReason={null}
        onConfirm={() => {
          setConfirming(false);
          onExit("discard");
        }}
      />
    </>
  );
}
