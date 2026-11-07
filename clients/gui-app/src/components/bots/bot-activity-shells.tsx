import type { ReactNode } from "react";
import { create, useStore } from "zustand";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import type { BotSessionOpen } from "@/stores/bots/bot-open-thread-store";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";

type ShellState = Pick<
  ChatSessionState,
  "managedCommands" | "snapshotLoaded" | "connectionStatus"
>;
const unavailable = create<ShellState>()(() => ({
  managedCommands: [],
  snapshotLoaded: false,
  connectionStatus: "connecting",
}));

/** Reads existing sessions only: opening Activity must not start chat streams. */
export function BotActivityShells(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly trunkChatId: string;
  readonly threads: ReadonlyArray<BotThreadSummary> | null;
  readonly onOpenSession: BotSessionOpen;
}): ReactNode {
  return (
    <section
      className="mt-4 flex flex-col gap-1"
      aria-label="Shells and monitors"
    >
      <h3 className="text-ui-xs tracking-[0.08em] text-muted-foreground uppercase">
        Shells and monitors
      </h3>
      <p className="text-ui-xs text-muted-foreground">
        Shows sessions loaded in this window. Other sessions may have shells.
      </p>
      <SessionShells
        {...props}
        chatId={props.trunkChatId}
        threadId={null}
        label="Trunk session"
      />
      {props.threads === null ? (
        <p className="text-ui-xs text-muted-foreground">
          Thread sessions unavailable
        </p>
      ) : (
        props.threads.map((thread) => (
          <SessionShells
            key={thread.threadId}
            {...props}
            chatId={thread.sessionChatId}
            threadId={thread.threadId}
            label={`Thread: ${thread.anchor?.excerpt ?? thread.threadId}`}
          />
        ))
      )}
    </section>
  );
}

function SessionShells(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly chatId: string;
  readonly threadId: string | null;
  readonly label: string;
  readonly onOpenSession: BotSessionOpen;
}): ReactNode {
  const handle = useExistingChatSessionHandle(
    props.botId,
    props.chatId,
    props.hostId,
  );
  const store = handle?.store ?? unavailable;
  const commands = useStore(store, (state) => state.managedCommands);
  const loaded = useStore(store, (state) => state.snapshotLoaded);
  const status = useStore(store, (state) => state.connectionStatus);
  const known = loaded && status === "open";
  if (props.threadId !== null && handle === null) return null;
  return (
    <div className="text-ui-xs">
      <p className="font-medium">{props.label}</p>
      {!known && <p className="text-muted-foreground">Shells unavailable</p>}
      {known && commands.length === 0 ? (
        <p className="text-muted-foreground">No shells</p>
      ) : null}
      {known && commands.length > 0 ? (
        <ul>
          {commands.map((command) => (
            <li key={command.id} className="flex flex-wrap gap-x-2">
              <span>{command.description}</span>
              <span>{command.status.state}</span>
              <span>{command.monitoring ? "Monitor on" : "Monitor off"}</span>
              <button
                type="button"
                className="underline"
                onClick={() =>
                  props.onOpenSession({
                    chatId: props.chatId,
                    threadId: props.threadId,
                    messageId: null,
                    sendPostId: null,
                  })
                }
              >
                Open session
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
