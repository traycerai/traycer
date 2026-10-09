import { useState } from "react";
import { Plus } from "lucide-react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSwitcherCreateArtifact } from "@/components/epic-canvas/mobile/use-switcher-create-artifact";
import { MobileNewTerminalDialog } from "@/components/epic-canvas/mobile/mobile-new-terminal-dialog";
import { SwitcherNewItemRow } from "@/components/epic-canvas/mobile/switcher-list-row";
import {
  EPIC_NODE_ICONS,
  EPIC_NODE_LABELS,
} from "@/lib/artifacts/node-display";

const ARTIFACT_KINDS: ReadonlyArray<EpicArtifactKind> = [
  "spec",
  "ticket",
  "story",
  "review",
];

interface SwitcherCreateProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * "New chat" affordance for the Agents category: the same header "+" the
 * Artifacts category carries, so both tabs put creating in one place rather
 * than each teaching its own.
 *
 * Creates an empty agent and opens it (`useSwitcherNewChat`, owned by the
 * agents list so the tree's "New child agent" shares it); the first message is
 * typed in the chat itself. The phone has no New Conversation modal.
 */
export function SwitcherNewChatAction(props: {
  readonly onSelect: () => void;
  readonly isPending: boolean;
}) {
  return (
    <Button
      type="button"
      variant="muted"
      size="icon-sm"
      aria-label="New chat"
      data-testid="switcher-new-chat"
      disabled={props.isPending}
      onClick={props.onSelect}
    >
      {props.isPending ? (
        <AgentSpinningDots
          className="size-4"
          testId="switcher-new-chat-pending"
          variant="dots2"
        />
      ) : (
        <Plus className="size-4" />
      )}
    </Button>
  );
}

/**
 * "New terminal" row for the Terminals category. The host + folder picker needs
 * a surface of its own, and a row inside a bottom sheet is no anchor for the
 * desktop popover, so the row opens the picker as a dialog. Launching closes
 * the sheet, landing the new terminal as the visible tile.
 */
export function SwitcherNewTerminalRow(props: SwitcherCreateProps) {
  const { epicId, tabId, onClose } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <>
      <SwitcherNewItemRow
        label="New terminal"
        onSelect={() => setPickerOpen(true)}
        testId="switcher-new-terminal"
      />
      <MobileNewTerminalDialog
        epicId={epicId}
        tabId={tabId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onLaunched={onClose}
      />
    </>
  );
}

/**
 * "New artifact" affordance for the Artifacts category: a curated kind menu
 * (spec / ticket / story / review) that fires the exact desktop create path
 * (`useEpicCreateArtifact` + open-when-projected). The artifact tile is not an
 * embed kind, so the sheet's watcher won't close on it; instead the create hook
 * closes the sheet (via `onClose`) the moment the tile opens, landing it as the
 * visible tile. `AddNodeDropdown` can't be filtered to artifact kinds, so the
 * menu is bespoke but the create function is shared.
 */
export function SwitcherNewArtifactMenu(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { create, isPending } = useSwitcherCreateArtifact(
    props.epicId,
    props.tabId,
    props.onClose,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="muted"
          size="icon-sm"
          aria-label="New artifact"
          data-testid="switcher-new-artifact"
          disabled={isPending}
        >
          {isPending ? (
            <AgentSpinningDots
              className="size-4"
              testId="switcher-new-artifact-pending"
              variant="dots2"
            />
          ) : (
            <Plus className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ARTIFACT_KINDS.map((kind) => {
          const Icon = EPIC_NODE_ICONS[kind];
          return (
            <DropdownMenuItem
              key={kind}
              data-testid={`switcher-new-artifact-${kind}`}
              onSelect={() => create(kind)}
            >
              <Icon className="size-3.5" />
              {EPIC_NODE_LABELS[kind]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
