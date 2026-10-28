import { useMemo } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { mintNewEpicTerminalTile } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  openChatClone,
  useChatCloneAvailable,
} from "@/lib/chats/chat-clone-registry";
import type { RestingChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import type { SandboxAgentRemedies } from "@/lib/sandboxes/sandbox-agent-refusal";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";

/**
 * What a chat bound to a sandbox offers beside "Choose a model" when its
 * agent cannot run there, resting or awake: a folderless terminal on that
 * sandbox in this task (opening it wakes a resting one, as any opened tab
 * does), the chat continued on another host (its fork dialog, which carries
 * the draft to the clone), the message withdrawn, and the sandbox's details.
 *
 * The sandbox is the resting one the copy names, or the tab host's own row
 * in the sandbox list while it is awake; a host that is no sandbox has
 * neither, and its gate refuses nothing anyway.
 */
export function useBoundSandboxRemedies(input: {
  readonly chatId: string;
  readonly epicId: string | null;
  readonly viewTabId: string | null;
  readonly hostId: string;
  readonly restingSandbox: RestingChatSandbox | null;
  readonly onCancelMessage: () => void;
}): SandboxAgentRemedies {
  const { chatId, epicId, viewTabId, hostId, onCancelMessage } = input;
  const list = useSandboxList();
  const sandbox: SandboxSummary | null =
    input.restingSandbox?.sandbox ??
    list.data?.sandboxes.find((row) => row.hostId === hostId) ??
    null;
  const cloneAvailable = useChatCloneAvailable(chatId);
  const { openTile } = useEpicTileNavigation();
  return useMemo((): SandboxAgentRemedies => {
    if (sandbox === null) return { onCancelMessage };
    return {
      onOpenTerminalInstead:
        epicId === null
          ? undefined
          : () => {
              openTile(
                tileIntent(
                  mintNewEpicTerminalTile({
                    hostId: sandbox.hostId,
                    epicId,
                    cwd: "",
                  }),
                  viewTabId === null ? { epicId } : { tabId: viewTabId },
                  "explicit",
                  "direct_ui",
                ),
              );
            },
      onChooseAnotherHost: cloneAvailable
        ? () => {
            openChatClone(chatId);
          }
        : undefined,
      onCancelMessage,
      onDetails: () => openSandboxDetails(sandbox.id),
    };
  }, [
    chatId,
    cloneAvailable,
    epicId,
    onCancelMessage,
    openTile,
    sandbox,
    viewTabId,
  ]);
}
