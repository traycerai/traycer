import { useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { useScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";

function unusedClientMethod(): never {
  throw new Error("not exercised by this test");
}

/**
 * A fake `browser.screencast` client, same shape as
 * `pip-headless-stream.test.ts`'s harness: a bare `IStreamSession` whose
 * `sendClientFrame` records the envelope, and an `IHostStreamClient` whose
 * `subscribe` hands that session back.
 */
function createScreencastClientHarness(id: string): {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly sentClientFrames: StreamFrameEnvelope[];
} {
  const sentClientFrames: StreamFrameEnvelope[] = [];
  const session: IStreamSession = {
    sendClientFrame(envelope) {
      sentClientFrames.push(envelope);
    },
    onServerFrame() {},
    onStatusChange() {},
    getNegotiatedSchemaVersion: () => null,
    requestReconnect() {},
    close() {},
  };
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe() {
      return session;
    },
    subscribeWithParamsProvider: unusedClientMethod,
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
    instanceId: `use-screencast-session-viewport-test-client-${id}`,
  };
  return { client, sentClientFrames };
}

function viewportFrames(
  frames: readonly StreamFrameEnvelope[],
): readonly BrowserScreencastClientFrame[] {
  return frames.filter(
    (frame): frame is BrowserScreencastClientFrame & { kind: "viewport" } =>
      frame.kind === "viewport",
  );
}

/**
 * Mounts the hook with a real DOM tile: `viewportRef`'s element is stubbed to
 * report a nonzero `clientWidth`/`clientHeight` (jsdom has no layout, so both
 * default to 0) via a callback ref that runs at commit - before any passive
 * effect, including the viewport bridge's - so the bridge's first-measurement
 * check sees real dimensions on the very first render.
 */
function Harness(props: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
}): React.JSX.Element {
  const session = useScreencastSession({
    client: props.client,
    epicId: "epic-1",
    hostId: "host-1",
    sessionId: "session-1",
    tabId: "tab-1",
    visible: true,
    captureDormantSnapshot: () => {},
  });
  // Destructured to locals before any JSX use: `react-hooks/refs` rejects a
  // `session.refs.x` member expression as a `ref=` prop (reading a ref during
  // render), and `react-hooks/immutability` rejects writing `.current` through
  // one. Same idiom as the `browser-peek-tile-*` fixtures.
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
      <div
        ref={(el) => {
          viewportRef.current = el;
          if (el !== null) {
            Object.defineProperty(el, "clientWidth", {
              configurable: true,
              value: 1272,
            });
            Object.defineProperty(el, "clientHeight", {
              configurable: true,
              value: 800,
            });
          }
        }}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the video plane's paint surface, not media content. */}
        <video ref={videoRef} />
        <img ref={imageRef} alt="surface" />
        <button ref={overlayButtonRef} type="button" />
        <input ref={imeInputRef} />
      </div>
    </div>
  );
}

describe("useScreencastSession viewport bridge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the measured viewport on mount without waiting out the debounce", () => {
    vi.useFakeTimers();
    const harnessA = createScreencastClientHarness("a");

    act(() => {
      render(<Harness client={harnessA.client} />);
    });

    // No `vi.advanceTimersByTime` call: the first measurement is not resize
    // churn, so it must not wait out VIEWPORT_DEBOUNCE_MS (200ms).
    expect(viewportFrames(harnessA.sentClientFrames)).toEqual([
      {
        kind: "viewport",
        hasBinaryPayload: false,
        width: 1272,
        height: 800,
        dpr: window.devicePixelRatio,
      },
    ]);
  });

  it("restates the last measured viewport on a re-subscribe with no resize in between", () => {
    vi.useFakeTimers();
    const harnessA = createScreencastClientHarness("a");
    const harnessB = createScreencastClientHarness("b");

    function Root(): React.JSX.Element {
      const [client, setClient] = useState(harnessA.client);
      return (
        <div>
          <button
            type="button"
            data-testid="swap"
            onClick={() => setClient(harnessB.client)}
          />
          <Harness client={client} />
        </div>
      );
    }

    const view = render(<Root />);
    expect(viewportFrames(harnessA.sentClientFrames)).toHaveLength(1);
    expect(viewportFrames(harnessB.sentClientFrames)).toHaveLength(0);

    // Force the subscription effect to re-run by swapping `client` - a
    // re-subscribe, tile already mounted and measured, no resize in between.
    act(() => {
      view.getByTestId("swap").click();
    });

    // The fix: the new stream still gets the tile's real geometry, not the
    // host's default metrics.
    expect(viewportFrames(harnessB.sentClientFrames)).toEqual([
      {
        kind: "viewport",
        hasBinaryPayload: false,
        width: 1272,
        height: 800,
        dpr: window.devicePixelRatio,
      },
    ]);
  });
});
