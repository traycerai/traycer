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
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
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

/**
 * "New agent" affordance for the Agents category: opens the shared New
 * Conversation modal via the exact P1.3 funnel (force chat mode, then request
 * the modal with `ACTIVE_TILE_PLACEMENT`). The modal's Chat/Terminal interface
 * switcher covers both a GUI chat and a TUI terminal-agent, so one entry point
 * serves the whole Agents category. The modal replaces the sheet, so we close
 * the sheet as it opens.
 */
export function SwitcherNewAgentButton(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { epicId, tabId, onClose } = props;
  const handleClick = () => {
    useNewConversationModalStore.getState().setComposerMode(epicId, "chat");
    useNewConversationModalOpenStore.getState().open({
      epicId,
      tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: null,
      hostId: null,
    });
    onClose();
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="New agent"
      data-testid="switcher-new-agent"
      className="text-muted-foreground hover:text-foreground"
      onClick={handleClick}
    >
      <Plus className="size-4" />
    </Button>
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
          variant="ghost"
          size="icon-sm"
          aria-label="New artifact"
          data-testid="switcher-new-artifact"
          disabled={isPending}
          className="text-muted-foreground hover:text-foreground"
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
