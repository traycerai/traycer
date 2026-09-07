import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  __getOpenEpicRegistryForTests,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import {
  useActiveEpicHostId,
  useActiveEpicProjection,
} from "@/lib/commands/sources/open/use-active-epic-projection";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

/** Codex #1243 T-55 - the palette's opener sub-pages froze after a re-point. */

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const EPIC = "epic-rebind";

function buildHandle(hostId: string): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: EPIC,
    userId: null,
    // The factories go to the COMPOSITION now, not the store: `createOpenEpicStore` stopped constructing a runtime, so a suite that used to hand it a `streamClientFactory` has nothing to hand it.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  handleHostIds.set(handle, hostId);
  return handle;
}

/** The chat id list is a stand-in for any projection the sub-pages render. */
function setChatCount(handle: OpenedStoreForTest, count: number): void {
  const allIds: string[] = [];
  for (let i = 0; i < count; i += 1) allIds.push(`chat-${i}`);
  handle.store.setState((state) => ({
    chats: { ...state.chats, allIds },
  }));
}

function Probe(): ReactNode {
  const projection = useActiveEpicProjection(EPIC);
  const hostId = useActiveEpicHostId(EPIC);
  return (
    <>
      <span data-testid="chat-count">
        {projection === null ? "none" : String(projection.chats.allIds.length)}
      </span>
      <span data-testid="host-id">{hostId ?? "none"}</span>
    </>
  );
}

describe("the active epic's projection follows a re-point", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("re-renders on mutations to the REPLACEMENT store, not just at the swap", () => {
    const registry = __getOpenEpicRegistryForTests();
    const outgoing = buildHandle("host-a");
    setChatCount(outgoing, 1);
    registry.acquireMounted(EPIC, () => outgoing);

    render(<Probe />);

    // Premise: the hook is live on the OUTGOING handle before anything moves.
    expect(screen.getByTestId("chat-count").textContent).toBe("1");
    expect(screen.getByTestId("host-id").textContent).toBe("host-a");

    const incoming = buildHandle("host-b");
    setChatCount(incoming, 2);
    act(() => {
      registry.replaceMounted(EPIC, outgoing, incoming, {
        hostStamp: "host-a",
        ownerIdentityKey: "key-a",
        editsTransferredToReplacement: false,
      });
    });

    // The registry emit refreshes both reads once. The BROKEN version passes
    // here too - which is why this is a premise and not the assertion.
    expect(screen.getByTestId("chat-count").textContent).toBe("2");
    expect(screen.getByTestId("host-id").textContent).toBe("host-b");

    // THE ASSERTION.
    // A projection mutation on the replacement, with no registry event behind it.
    act(() => {
      setChatCount(incoming, 5);
    });
    expect(screen.getByTestId("chat-count").textContent).toBe("5");
  });
});
