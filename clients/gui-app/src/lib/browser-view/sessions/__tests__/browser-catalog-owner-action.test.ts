import { afterEach, describe, expect, it } from "vitest";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { BrowserSessionsServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { closeBrowserCatalogTab } from "@/lib/browser-view/sessions/browser-catalog-owner-action";
import { acquireBrowserSessionsCoordinator } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  coordinatorKey,
  epicScope,
  owner,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { useAuthStore } from "@/stores/auth/auth-store";

const SNAPSHOT: BrowserSessionsServerFrame = {
  kind: "snapshot",
  hasBinaryPayload: false,
  sessions: [sessionInfo({ tabs: [tabInfo({})] })],
};

describe("closing a Browsers panel row on a device whose stream already ended", () => {
  const releasers: Array<() => void> = [];
  afterEach(() => {
    for (const release of releasers.splice(0)) release();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("starts the device's stream again and closes the tab, instead of failing at once", async () => {
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: "user-1", userName: "user-1", email: "u@example.com" },
      contextMetadata: { userId: "user-1", username: "user-1" },
    });
    const clients: FakeStreamClient[] = [];
    const runtime = {
      browserView: null,
      userId: "user-1",
      localHostId: null,
      presentation: null,
      navigateNested: () => null,
      openTransport: (): DurableStreamTransport => {
        const client = new FakeStreamClient(true);
        clients.push(client);
        return { wsStreamClient: client, close: () => undefined };
      },
    };
    const scope = epicScope("epic-1");
    // What the link opener's provider does for the whole life of a view tab:
    // it holds this device's coordinator, so a close reuses it.
    releasers.push(
      acquireBrowserSessionsCoordinator({
        key: coordinatorKey(scope, {}),
        consumerId: Symbol("link-open-provider"),
        scope,
        owner: owner({}),
        runtime,
        createIfMissing: true,
      }),
    );
    const ended = clients.at(0)?.sessions.at(0);
    if (ended === undefined) throw new Error("no stream was subscribed");
    ended.emit(SNAPSHOT, null);
    ended.emitStatus("closed");

    const closing = closeBrowserCatalogTab({
      identity: { epicId: "epic-1", hostId: "host-1", sessionId: "session-1" },
      tabId: "tab-1",
      owner: owner({}),
      runtime,
    });
    const settled = closing.then(
      () => "closed",
      (error: unknown) => (error instanceof Error ? error.message : "rejected"),
    );

    const restarted = clients.at(1)?.sessions.at(0);
    if (restarted === undefined) {
      throw new Error(`no stream was started again: ${await settled}`);
    }
    restarted.emit(SNAPSHOT, null);
    await Promise.resolve();
    const request = restarted.sentFrames.find(
      (frame) => frame.kind === "closeTab",
    );
    if (request === undefined) throw new Error("no closeTab was sent");
    restarted.emit(
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: String(request.requestId),
        ok: true,
        reason: null,
      },
      null,
    );

    await expect(settled).resolves.toBe("closed");
  });
});
