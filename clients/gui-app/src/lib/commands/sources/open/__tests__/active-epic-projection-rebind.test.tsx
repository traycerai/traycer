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
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

/**
 * Codex #1243 T-55 - the palette's opener sub-pages froze after a re-point.
 *
 * `useActiveEpicProjection` resolved the handle INSIDE a `subscribe` callback
 * keyed on `epicId` alone. A re-point swaps the registry's handle without
 * changing the epic id, so React never re-ran `subscribe` and the hook stayed
 * bound to the OUTGOING handle's store. The registry `emit()` that follows the
 * swap refreshes the snapshot exactly once and then goes quiet - the
 * registry's own subscription is eligibility-keyed and deliberately does not
 * fire on ordinary projection mutations. So chats, artifacts, files and TUI
 * items in the palette sat at that one snapshot until the sub-page remounted.
 *
 * The distinction this file has to hold onto is that the ONE refresh makes the
 * broken version look fixed at the moment of the swap. Asserting the value
 * right after `replaceMounted` passes either way. Only a mutation made on the
 * NEW store AFTERWARDS separates "re-read once" from "resubscribed".
 *
 * The mirror-image half - that the subscription to the OUTGOING store is
 * released - is deliberately NOT asserted here, because at this seam it
 * cannot fail. A leaked subscriber still resolves its snapshot through the
 * registry, so a write to the outgoing store hands React the replacement's
 * unchanged state object and React bails out: same rendered value, same
 * render count, leaked subscription and released subscription alike. Both
 * shapes of that assertion were written, probed against the pre-fix version,
 * and passed - so they were removed rather than kept as coverage that cannot
 * discriminate. The leak is real but is a wasted `getSnapshot` call, not an
 * observable behaviour, and the arm below is what pins the defect that is.
 */

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const EPIC = "epic-rebind";

function buildHandle(hostId: string): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId: EPIC,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handleHostIds.set(handle, hostId);
  return handle;
}

/**
 * The chat id list is a stand-in for any projection the sub-pages render.
 *
 * Only `allIds` is written - the probe reads its length and nothing walks
 * `byId`, so seeding records would add a shape to keep in step with the real
 * projector for no assertion's benefit.
 */
function setChatCount(handle: OpenEpicStoreHandle, count: number): void {
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

    // THE ASSERTION. A projection mutation on the replacement, with no
    // registry event behind it. A hook still subscribed to the outgoing
    // store never hears this and stays at 2.
    act(() => {
      setChatCount(incoming, 5);
    });
    expect(screen.getByTestId("chat-count").textContent).toBe("5");
  });
});
