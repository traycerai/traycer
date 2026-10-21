import type {
  ChatServingKey,
  ChatServingVerdict,
  ChatServingWitness,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer/protocol/host-transport/stream-session";
import {
  chatServingSubscribeV10,
  type ChatServing,
} from "@traycer/protocol/host/chat-serving/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * A {@link ChatServingWitness} the app can also ask for the display state
 * (`catching-up`) and tell which chats it is looking at.
 */
export interface RetainingChatServingWitness extends ChatServingWitness {
  /**
   * Keeps the chat's serving state subscribed while the returned release has
   * not been called. Reference-counted per chat.
   */
  retain(chat: ChatServingKey): () => void;
  /** The server's last published state for the chat; null before the first. */
  servingFor(chat: ChatServingKey): ChatServing | null;
}

interface Watched {
  readonly epicId: string;
  readonly chatId: string;
  refs: number;
  serving: ChatServing | null;
  session: IStreamSession | null;
}

function watchKey(chat: ChatServingKey): string {
  return `${chat.epicId}\u0000${chat.chatId}`;
}

/**
 * The server's published serving state per chat, read over the pool's
 * `chat.serving.subscribe`.
 *
 * A verdict changes only when the pool sends a frame. Nothing here reads a
 * host's reachability, and a pool session that drops keeps every verdict it
 * last heard until the session's own reconnect delivers a new frame, so a
 * blip on either peer never moves a chat between them.
 */
export class PoolChatServingWitness implements RetainingChatServingWitness {
  private readonly watched = new Map<string, Watched>();
  private readonly listeners = new Set<() => void>();
  private client: IHostStreamClient<HostStreamRpcRegistry> | null = null;

  verdictFor(chat: ChatServingKey): ChatServingVerdict {
    const serving = this.servingFor(chat);
    if (serving === null) return "unknown";
    // Keyed by the chat's CURRENT owner host: a tab bound to the host the
    // chat moved away from reads it at rest.
    return serving.state === "live" && serving.ownerHostId === chat.hostId
      ? "live"
      : "at-rest";
  }

  servingFor(chat: ChatServingKey): ChatServing | null {
    return this.watched.get(watchKey(chat))?.serving ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  retain(chat: ChatServingKey): () => void {
    const key = watchKey(chat);
    let watched = this.watched.get(key);
    if (watched === undefined) {
      watched = {
        epicId: chat.epicId,
        chatId: chat.chatId,
        refs: 0,
        serving: null,
        session: null,
      };
      this.watched.set(key, watched);
    }
    watched.refs += 1;
    if (watched.session === null) this.open(key, watched);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.watched.get(key);
      if (current === undefined) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      current.session?.close();
      this.watched.delete(key);
    };
  }

  /**
   * The pool's stream client, or null while it is not ready (not built yet,
   * or still the previous account's). A new client reopens every retained
   * chat on it; the states already heard are kept until it answers.
   */
  setStreamClient(
    client: IHostStreamClient<HostStreamRpcRegistry> | null,
  ): void {
    if (client === this.client) return;
    this.client = client;
    for (const [key, watched] of this.watched) {
      watched.session?.close();
      watched.session = null;
      this.open(key, watched);
    }
  }

  /** Closes every subscription; the witness is not used again. */
  dispose(): void {
    for (const watched of this.watched.values()) watched.session?.close();
    this.watched.clear();
    this.listeners.clear();
    this.client = null;
  }

  private open(key: string, watched: Watched): void {
    const client = this.client;
    if (client === null) return;
    const session = client.subscribe("chat.serving.subscribe", {
      epicId: watched.epicId,
      chatId: watched.chatId,
    });
    watched.session = session;
    session.onServerFrame((envelope) => {
      const parsed =
        chatServingSubscribeV10.serverFrameSchema.safeParse(envelope);
      if (!parsed.success) return;
      const current = this.watched.get(key);
      if (current?.session !== session) return;
      current.serving = parsed.data.serving;
      this.notify();
    });
    // A fatal close is final: the pool ends the stream `CHAT_NOT_VISIBLE`
    // for a chat it cannot show yet, such as one a team host has not
    // published. The dead session is dropped so the next `retain` opens a
    // fresh one; the caller's re-retain on publication is what asks.
    session.onStatusChange((status, reason) => {
      if (status !== "closed" || reason?.kind !== "fatalError") return;
      const current = this.watched.get(key);
      if (current?.session === session) current.session = null;
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
