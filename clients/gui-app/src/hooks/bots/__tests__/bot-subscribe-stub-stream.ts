import { vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BotSubscribeServerFrame } from "@traycer/protocol/host/bot/schemas";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamParamsProvider } from "@traycer-clients/shared/host-transport/i-stream-client";

/** A `bot.subscribe` session the test drives: `emit` delivers a server frame. */
export class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  readonly close = vi.fn();

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(_handler: StatusChangeHandler): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}

  emit(frame: BotSubscribeServerFrame): void {
    this.serverFrameHandler(frame, null);
  }
}

/** A stream client whose every subscribe is `session`; nothing else is reached. */
export class StubHostStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId = "stub-stream-client";
  /** Each stream method a caller opened, in order. */
  readonly opened: string[] = [];

  constructor(private readonly session: IStreamSession) {}

  isReady(): boolean {
    return true;
  }

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.opened.push(method);
    return this.session;
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: StreamParamsProvider<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {}

  isClosed(): boolean {
    return false;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => {};
  }

  notifyBearerRotated(): void {}
  notifyCloudVerdictChanged(): void {}

  reconnectAll(_reason: string, _options: ReconnectAllOptions): void {}

  getMethodSupport(): StreamMethodSupport {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => {};
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => {};
  }
}
