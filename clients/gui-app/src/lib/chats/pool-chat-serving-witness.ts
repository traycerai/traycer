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
  /**
   * Reports the chat's publication: opens a fresh stream for a retained chat
   * whose last one ended with a fatal close, keeping its holders and the
   * state already heard. Acted on once per retained chat, so a second
   * holder's report of the same publication is a no-op, as is one for a chat
   * not retained.
   */
  reopen(chat: ChatServingKey): void;
  /** The server's last published state for the chat; null before the first. */
  servingFor(chat: ChatServingKey): ChatServing | null;
}

interface Watched {
  readonly epicId: string;
  readonly chatId: string;
  refs: number;
  serving: ChatServing | null;
  session: IStreamSession | null;
  /** Whether `session` has delivered a frame. */
  heard: boolean;
  /**
   * Whether the chat's publication was already acted on. Every holder reports
   * the same transition, so only the first report opens or arms a stream.
   */
  publicationSeen: boolean;
  /**
   * The unanswered session the chat's publication arrived during, reopened
   * once if the pool still ends it `CHAT_NOT_VISIBLE`.
   */
  publishedDuring: IStreamSession | null;
}

const CHAT_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";

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
        heard: false,
        publicationSeen: false,
        publishedDuring: null,
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

  reopen(chat: ChatServingKey): void {
    const key = watchKey(chat);
    const watched = this.watched.get(key);
    if (watched === undefined || watched.publicationSeen) return;
    watched.publicationSeen = true;
    if (watched.session === null) {
      this.open(key, watched);
      return;
    }
    // The publication can arrive while the stream opened before it is still
    // unanswered; that stream may yet end `CHAT_NOT_VISIBLE`, so the signal is
    // kept for it. A stream that has delivered a frame is healthy and left alone.
    if (!watched.heard) watched.publishedDuring = watched.session;
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
    watched.heard = false;
    watched.publishedDuring = null;
    session.onServerFrame((envelope) => {
      const parsed =
        chatServingSubscribeV10.serverFrameSchema.safeParse(envelope);
      if (!parsed.success) return;
      const current = this.watched.get(key);
      if (current?.session !== session) return;
      current.heard = true;
      current.publishedDuring = null;
      current.serving = parsed.data.serving;
      this.notify();
    });
    // A fatal close is final: the pool ends the stream `CHAT_NOT_VISIBLE`
    // for a chat it cannot show yet, such as one a team host has not
    // published. The dead session is dropped so `reopen` (asked on
    // publication) or the next first `retain` opens a fresh one; a
    // publication already heard while it was in flight reopens it here.
    session.onStatusChange((status, reason) => {
      if (status !== "closed" || reason?.kind !== "fatalError") return;
      const current = this.watched.get(key);
      if (current?.session !== session) return;
      current.session = null;
      if (
        current.publishedDuring === session &&
        reason.details.code === CHAT_NOT_VISIBLE_CODE
      ) {
        this.open(key, current);
      }
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
