import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
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
   */
  readonly setCommands: (commands: readonly ManagedCommand[]) => void;
  readonly setConnectionStatus: (status: StreamConnectionStatus) => void;
  readonly dispose: () => void;
}

const TEST_SCOPE_KEY = "managed-command-test-scope";

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

  return {
    setCommands: (commands) => {
      callbacks().onManagedCommandsChanged({
        kind: "managedCommandsChanged",
        hasBinaryPayload: false,
        epicId,
        chatId,
        managedCommands: [...commands],
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

/** Tears down every session a suite installed, whichever chats they were for. */
export function disposeManagedCommandChatSessions(): void {
  __getChatSessionRegistryForTests().disposeAll();
}
