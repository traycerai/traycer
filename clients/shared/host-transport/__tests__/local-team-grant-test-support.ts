import type {
  ClientFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import type { OpenFrameBearerSource } from "../../auth/bearer-source";
import type { LocalSessionGrantProvision } from "../local-open-auth";

export type LocalTeamGrantMint = (
  hostId: string,
  bearer: OpenFrameBearerSource,
  signal: AbortSignal,
) => Promise<LocalSessionGrantProvision>;

function queuedSockets<Socket>(create: () => Socket): {
  readonly sockets: Socket[];
  readonly create: () => Socket;
  readonly nextSocket: () => Promise<Socket>;
} {
  const sockets: Socket[] = [];
  const queued: Socket[] = [];
  const waiters: Array<(socket: Socket) => void> = [];
  return {
    sockets,
    create: () => {
      const socket = create();
      sockets.push(socket);
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(socket);
      else waiter(socket);
      return socket;
    },
    nextSocket: () => {
      const socket = queued.shift();
      if (socket !== undefined) return Promise.resolve(socket);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export class LocalGrantRpcSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: ClientFrame[] = [];
  private readonly frameWaiters: Array<{
    readonly fromIndex: number;
    readonly predicate: (frame: ClientFrame) => boolean;
    readonly resolve: (frame: ClientFrame) => void;
  }> = [];

  send(data: string): void {
    const frame = JSON.parse(data) as ClientFrame;
    const index = this.sent.push(frame) - 1;
    for (const waiter of [...this.frameWaiters]) {
      if (index < waiter.fromIndex || !waiter.predicate(frame)) continue;
      this.frameWaiters.splice(this.frameWaiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  }

  close(): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(frame: HostFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  waitForFrame(
    predicate: (frame: ClientFrame) => boolean,
    fromIndex: number | undefined,
  ): Promise<ClientFrame> {
    const startIndex = fromIndex ?? 0;
    const existing = this.sent.slice(startIndex).find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.frameWaiters.push({ fromIndex: startIndex, predicate, resolve });
    });
  }
}

export interface LocalGrantRpcSocketFactory {
  readonly factory: IWebSocketFactory;
  readonly sockets: LocalGrantRpcSocket[];
  readonly nextSocket: () => Promise<LocalGrantRpcSocket>;
}

export function createLocalGrantRpcSocketFactory(): LocalGrantRpcSocketFactory {
  const queued = queuedSockets(() => new LocalGrantRpcSocket());
  return {
    factory: { create: () => queued.create() },
    sockets: queued.sockets,
    nextSocket: queued.nextSocket,
  };
}

export function parseLocalGrantStreamText(
  raw: string,
): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object frame");
  }
  return value as Record<string, unknown>;
}

export class LocalGrantStreamSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly textSent: string[] = [];
  private readonly frameWaiters: Array<{
    readonly fromIndex: number;
    readonly predicate: (frame: Record<string, unknown>) => boolean;
    readonly resolve: (frame: Record<string, unknown>) => void;
  }> = [];

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    const index = this.textSent.push(data) - 1;
    const frame = parseLocalGrantStreamText(data);
    for (const waiter of [...this.frameWaiters]) {
      if (index < waiter.fromIndex || !waiter.predicate(frame)) continue;
      this.frameWaiters.splice(this.frameWaiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  }

  close(): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(frame: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
  }

  waitForFrame(
    predicate: (frame: Record<string, unknown>) => boolean,
    fromIndex: number | undefined,
  ): Promise<Record<string, unknown>> {
    const startIndex = fromIndex ?? 0;
    const existing = this.textSent
      .slice(startIndex)
      .map(parseLocalGrantStreamText)
      .find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.frameWaiters.push({ fromIndex: startIndex, predicate, resolve });
    });
  }
}

export interface LocalGrantStreamSocketFactory {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: LocalGrantStreamSocket[];
  readonly nextSocket: () => Promise<LocalGrantStreamSocket>;
}

export function createLocalGrantStreamSocketFactory(): LocalGrantStreamSocketFactory {
  const queued = queuedSockets(() => new LocalGrantStreamSocket());
  return {
    factory: { create: () => queued.create() },
    sockets: queued.sockets,
    nextSocket: queued.nextSocket,
  };
}
