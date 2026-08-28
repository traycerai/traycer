import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatSubscribeServerFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HeldManagedCommandUpdate,
  ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";

/**
 * A live chat session whose only faked boundary is its socket, registered so
 * the managed-command surfaces find it exactly as they do in the app.
 *
 * The commands a chat owns ride its `chat.subscribe` stream, so a suite that
 * used to install a list-stream stub now feeds real `managedCommandsChanged`
 * frames through a real chat session store: the reducer, the registry lookup
 * and the ordering are all the production ones.
 */
export interface ManagedCommandChatSessionStub {
  /**
   * The chat's whole set, as the host sends it - never a delta. Passing `[]`
   * is how a chat's last command goes away.
   *
   * Delivers the chat's SNAPSHOT the first time, and a `managedCommandsChanged`
   * frame after that, which is the order a real stream sends them in. That
   * order matters to any surface that waits for the host's first word before
   * reading an empty set as "deleted".
   */
  readonly setCommands: (commands: readonly ManagedCommand[]) => void;
  /**
   * A change frame with no snapshot before it - the pre-hydration window a
   * surface must not mistake for the host's answer.
   */
  readonly setCommandsWithoutSnapshot: (
    commands: readonly ManagedCommand[],
  ) => void;
  /**
   * The chat's whole set of held updates, as the host sends it on a
   * `heldUpdatesChanged` frame - never a delta. Unlike {@link setCommands} this
   * needs no snapshot-first ordering: the store's `onHeldUpdatesChanged`
   * handler is a plain assignment gated only on chat identity, the same as
   * {@link setCommandsWithoutSnapshot}'s frame.
   */
  readonly setHeldUpdates: (
    heldUpdates: readonly HeldManagedCommandUpdate[],
  ) => void;
  readonly setConnectionStatus: (status: StreamConnectionStatus) => void;
  readonly dispose: () => void;
}

type ChatSnapshot = Extract<
  ChatSubscribeServerFrame,
  { readonly kind: "snapshot" }
>["snapshot"];

const TEST_SCOPE_KEY = "managed-command-test-scope";
const TEST_USER_ID = "user-1";

export function installManagedCommandChatSession(args: {
  readonly epicId: string;
  readonly chatId: string;
  /** The host this session belongs to - part of the registry's session
   *  identity, so the surface under test must be bound to the same one. */
  readonly hostId: string;
}): ManagedCommandChatSessionStub {
  const { epicId, chatId, hostId } = args;
  const registry = __getChatSessionRegistryForTests();
  let captured: ChatStreamCallbacks | null = null;

  registry.acquire(
    {
      epicId,
      chatId,
      hostId,
      scopeKey: TEST_SCOPE_KEY,
    },
    (storeEpicId, storeChatId) =>
      createChatSessionStore({
        hostId,
        epicId: storeEpicId,
        chatId: storeChatId,
        userId: null,
        streamClientFactory: (_epicId, _chatId, callbacks) => {
          captured = callbacks;
          return {
            sendAction: () => undefined,
            close: () => undefined,
            sameTurnSteeringProtocolSupported: () => true,
          };
        },
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        onAuthError: null,
        onProviderAuthError: null,
      }),
  );

  const callbacks = (): ChatStreamCallbacks => {
    if (captured === null) {
      throw new Error("chat stream callbacks were never wired");
    }
    return captured;
  };

  let snapshotDelivered = false;

  const changeFrame = (commands: readonly ManagedCommand[]): void => {
    callbacks().onManagedCommandsChanged({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId,
      chatId,
      managedCommands: [...commands],
    });
  };

  return {
    setCommands: (commands) => {
      if (snapshotDelivered) {
        changeFrame(commands);
        return;
      }
      snapshotDelivered = true;
      callbacks().onSnapshot({
        kind: "snapshot",
        hasBinaryPayload: false,
        epicId,
        chatId,
        snapshot: emptyChatSnapshot({ chatId, hostId, commands }),
      });
    },
    setCommandsWithoutSnapshot: (commands) => {
      changeFrame(commands);
    },
    setHeldUpdates: (heldUpdates) => {
      callbacks().onHeldUpdatesChanged({
        kind: "heldUpdatesChanged",
        hasBinaryPayload: false,
        epicId,
        chatId,
        heldUpdates: [...heldUpdates],
      });
    },
    setConnectionStatus: (status: StreamConnectionStatus) => {
      const reason: StreamCloseReason | null = null;
      callbacks().onConnectionStatus(status, reason);
    },
    dispose: () => {
      registry.forceRelease(epicId, chatId, hostId);
    },
  };
}

/**
 * The smallest chat a snapshot frame can describe, carrying the command set.
 * Every other field is the empty/idle value: these suites are about the
 * commands, and the snapshot is here so the session reaches the state a real
 * one does - `snapshotLoaded`, which is what tells an empty set apart from a
 * set that has not arrived.
 */
function emptyChatSnapshot(args: {
  readonly chatId: string;
  readonly hostId: string;
  readonly commands: readonly ManagedCommand[];
}): ChatSnapshot {
  return {
    chat: {
      id: args.chatId,
      parentId: null,
      userId: TEST_USER_ID,
      hostId: args.hostId,
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      isTitleEditedByUser: false,
      settings: null,
      activeSessionChain: null,
      claudePendingWakes: [],
      messages: [],
      events: [],
      archivedAt: null,
      pinnedUserProviderHandle: null,
      lastDeliveredRolesDigest: null,
    },
    access: { role: "owner", ownerUserId: TEST_USER_ID, canAct: true },
    queue: { status: "idle", items: [] },
    runStatus: "idle",
    activeTurn: null,
    turnInProgress: false,
    pendingApprovals: [],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
    accumulatedFileChanges: [],
    backgroundItems: [],
    managedCommands: [...args.commands],
    heldUpdates: [],
  };
}

/** Tears down every session a suite installed, whichever chats they were for. */
export function disposeManagedCommandChatSessions(): void {
  __getChatSessionRegistryForTests().disposeAll();
}
