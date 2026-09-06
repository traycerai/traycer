import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserScreencastOpenRequest } from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { useScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";
import {
  recordHandoffToken,
  resetHandoffTokensForTests,
} from "@/lib/browser-view/sessions/screencast-handoff-tokens";
import { independentScope } from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

function unusedClientMethod(): never {
  throw new Error("not exercised by this test");
}

/**
 * A fake `browser.screencast` client that records what each subscription
 * PRESENTED and which of them were closed - the two facts the handoff is made
 * of. Frames are not exercised here.
 */
function createSubscribingClientHarness(): {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly presented: Array<string | null>;
  readonly closed: number[];
} {
  const presented: Array<string | null> = [];
  const closed: number[] = [];
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe(method, params) {
      if (method !== "browser.screencast") unusedClientMethod();
      const index = presented.length;
      presented.push((params as BrowserScreencastOpenRequest).handoffToken);
      const session: IStreamSession = {
        sendClientFrame(_envelope: StreamFrameEnvelope) {},
        onServerFrame() {},
        onStatusChange(handler) {
          handler("connecting", null);
        },
        getNegotiatedSchemaVersion: () => null,
        requestReconnect() {},
        close() {
          closed.push(index);
        },
      };
      return session;
    },
    // These three are one seam, and the doubles must answer all three: the
    // browser wrappers open through `subscribeWithParamsProvider` (the open
    // request is shaped for the negotiated major) and through
    // `subscribeAtVersion` for the `independent` scope, which pins `@2`. A
    // double that answers only `subscribe` sends this test down a path
    // production never takes.
    subscribeWithParamsProvider(method, paramsProvider) {
      return this.subscribe(method, paramsProvider(null));
    },
    subscribeAtVersion(method, _schemaVersion, params) {
      return this.subscribe(method, params);
    },
    close() {},
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated() {},
    reconnectAll() {},
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => {},
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => {},
    getClosedReason: () => null,
    onClosed: () => () => {},
    instanceId: "use-screencast-session-handoff-test-client",
  };
  return { client, presented, closed };
}

const TAB = { hostId: "host-1", sessionId: "session-1", tabId: "tab-1" };

function Harness(props: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
}): React.JSX.Element {
  const session = useScreencastSession({
    client: props.client,
    scope: independentScope(),
    hostId: TAB.hostId,
    sessionId: TAB.sessionId,
    tabId: TAB.tabId,
    visible: true,
    captureDormantSnapshot: () => {},
  });
  const {
    tileRef,
    viewportRef,
    videoRef,
    imageRef,
    overlayButtonRef,
    imeInputRef,
  } = session.refs;
  return (
    <div ref={tileRef}>
      <div ref={viewportRef}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the video plane's paint surface, not media content. */}
        <video ref={videoRef} />
        <img ref={imageRef} alt="surface" />
        <button ref={overlayButtonRef} type="button" />
        <input ref={imeInputRef} />
      </div>
    </div>
  );
}

/**
 * The open that minted a handoff token and the tile that presents it meet
 * through the token registry, and the registry's common case is the token
 * being recorded before the tile exists. These pin the OTHER order: the
 * device's inventory listed the tab before the open's own answer landed, so
 * the tile was already subscribed - presenting `null` - when the token
 * arrived. Without a re-subscribe the opener never presents its token and the
 * host keeps the session's placement claim held.
 */
describe("useScreencastSession handoff token", () => {
  afterEach(() => {
    cleanup();
    resetHandoffTokensForTests();
  });

  it("presents a token recorded before it subscribed, without a restart", () => {
    const harness = createSubscribingClientHarness();
    recordHandoffToken(TAB, "token-1");

    act(() => {
      render(<Harness client={harness.client} />);
    });

    expect(harness.presented).toEqual(["token-1"]);
    expect(harness.closed).toEqual([]);
  });

  it("re-subscribes presenting a token recorded after it subscribed", () => {
    const harness = createSubscribingClientHarness();

    act(() => {
      render(<Harness client={harness.client} />);
    });
    expect(harness.presented).toEqual([null]);

    act(() => {
      recordHandoffToken(TAB, "token-1");
    });

    // The first stream is closed and one presenting the token replaces it.
    expect(harness.presented).toEqual([null, "token-1"]);
    expect(harness.closed).toEqual([0]);
  });

  it("ignores a token recorded for another tab", () => {
    const harness = createSubscribingClientHarness();

    act(() => {
      render(<Harness client={harness.client} />);
    });
    act(() => {
      recordHandoffToken({ ...TAB, tabId: "tab-2" }, "token-2");
    });

    expect(harness.presented).toEqual([null]);
    expect(harness.closed).toEqual([]);
  });
});
