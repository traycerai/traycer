/**
 * What the module stubs of the `chat-tile-queue-edit-*` suites recorded
 * (`chat-tile-queue-edit-stubs.tsx`). Reset before each case by the harness.
 */
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ChatComposerSideChatInput,
  ChatComposerSubmitInput,
} from "@/components/chat/composer/chat-composer";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";

export const selectorCapture: { editSessionId: string | null } = {
  editSessionId: null,
};

/**
 * The slash-command lookups the tile makes for its own send paths (next-step
 * prompts, compaction, a sent message's inline edit) pass
 * `NO_LOCAL_SLASH_COMMANDS`; the composer passes its own commands. Recording
 * the former's working directories is how the tests read where the tile looks
 * those commands up. A host that answered `agent.gui.listCommands` per
 * directory would need a request harness this suite does not have.
 */
export const tileSlashLookups: { workingDirectories: ReadonlyArray<string> }[] =
  [];

export const submitCapture: {
  onSubmitMessage:
    | ((input: ChatComposerSubmitInput) => boolean | Promise<boolean>)
    | null;
  onSideChat: ((input: ChatComposerSideChatInput) => boolean) | null;
  mentionRoots: ReadonlyArray<string> | null;
  runWorkingDirectory: string | null;
} = {
  onSubmitMessage: null,
  onSideChat: null,
  mentionRoots: [],
  runWorkingDirectory: null,
};

/**
 * `startSideChatFromComposer` (chat-tile.tsx) bridges `startSideChat`'s
 * `createChat` seam onto `useEpicCreateChatForHost().mutate` - capturing calls
 * here, instead of a bare `vi.fn()`, is what lets the tests below drive
 * success/failure by hand and assert what happens in between (decision 14
 * refinement: the queue's edit pill clears synchronously on accept; the
 * captured queue item is cancelled only from a successful create).
 */
export interface CreateChatCallbacksCapture {
  readonly onSuccess: (result: {
    chatId: string;
    initialTurnStarted?: boolean;
  }) => void;
  readonly onError: (error: HostRpcError) => void;
}
interface CreateChatCall {
  readonly request: CreateChatMutationInput;
  readonly callbacks: CreateChatCallbacksCapture;
}
export const createChatCapture: { calls: CreateChatCall[] } = { calls: [] };
