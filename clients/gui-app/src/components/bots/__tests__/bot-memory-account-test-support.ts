/**
 * The scripted stream host and the account moves for the suites that mount
 * the real `useBotMemory`; the seams themselves are in the scripts module.
 */
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BotMemory } from "@traycer/protocol/host/bot/schemas";
import {
  MockStreamSession,
  MockWsStreamClient,
} from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import {
  holdBinding,
  scriptedRequestContext,
} from "@/components/bots/__tests__/bot-memory-account-scripts";
import { useAuthStore } from "@/stores/auth/auth-store";

/** A session that hands `memory` to its frame handler the moment it attaches. */
class AttachingSession extends MockStreamSession<StreamFrameEnvelope> {
  constructor(private readonly onAttach: BotMemory | null) {
    super();
  }

  override onServerFrame(handler: ServerFrameHandler): void {
    super.onServerFrame(handler);
    if (this.onAttach !== null) {
      this.emitFrame({
        kind: "snapshot",
        memory: this.onAttach,
        hasBinaryPayload: false,
      });
    }
  }
}

/**
 * A stream client that opens a fresh session for every subscribe, so a
 * session of an earlier lifetime stays a separate object a test can still
 * deliver a frame to.
 */
export class MemoryAccountStreamClient extends MockWsStreamClient<StreamFrameEnvelope> {
  support: StreamMethodSupport = "supported";
  readonly opened: {
    method: string;
    session: MockStreamSession<StreamFrameEnvelope>;
  }[] = [];
  /** Handed to the next session the moment its frame handler attaches. */
  frameOnNextAttach: BotMemory | null = null;

  override getMethodSupport(): StreamMethodSupport {
    return this.support;
  }

  override subscribeMethodSupport(): () => void {
    return () => undefined;
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    this.subscribeCallCount += 1;
    const session = new AttachingSession(this.frameOnNextAttach);
    this.frameOnNextAttach = null;
    this.opened.push({ method, session });
    return session;
  }

  memorySessions(): MockStreamSession<StreamFrameEnvelope>[] {
    return this.opened
      .filter((entry) => entry.method === "bot.memory.subscribe")
      .map((entry) => entry.session);
  }
}

/**
 * Signs `userId` in as the app does: the request context swaps first, the
 * store projects after it. `null` is signed out.
 */
export function signInAs(userId: string | null): void {
  scriptedRequestContext.set(userId);
  useAuthStore.setState({
    contextMetadata: userId === null ? null : { userId, username: "synthetic" },
  });
}

/** Back to nothing signed in and no binding held, for the next test. */
export function resetMemoryAccountScripts(): void {
  scriptedRequestContext.set(null);
  useAuthStore.setState({ contextMetadata: null });
  holdBinding(null, null);
}
