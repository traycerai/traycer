import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";

import {
  SET_CHAT_ARCHIVED_METHOD,
  useChatArchiveSupported,
  useChatArchiveSupportState,
} from "@/hooks/epic/use-chat-archive-support";

const SESSION_HOST_ID = "epic-session-host-test";
const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let sessionHandle: OpenedStoreForTest;

function SessionWrapper(props: { readonly children: ReactNode }): ReactNode {
  return createElement(
    EpicSessionContext.Provider,
    { value: sessionHandle },
    props.children,
  );
}

beforeEach(() => {
  resetNegotiatedManifests();
  sessionHandle = openStoreForTest({
    epicId: "epic-archive-support-test",
    userId: null,
    // The factories go to the COMPOSITION now, not the store:
    // `createOpenEpicStore` stopped constructing a runtime, so a
    // suite that used to hand it a `streamClientFactory` has nothing
    // to hand it. `handle.doc` still resolves because this harness
    // builds the runtime in THIS thread.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  handleHostIds.set(sessionHandle, SESSION_HOST_ID);
});

afterEach(() => {
  cleanup();
  handleHostIds.delete(sessionHandle);
  sessionHandle.dispose();
  resetNegotiatedManifests();
});

describe("chat archive capability routing", () => {
  it("checks affordance support against the Epic session host", () => {
    recordNegotiatedHostMethods("unrelated-default-host", []);
    recordNegotiatedHostMethods(SESSION_HOST_ID, [SET_CHAT_ARCHIVED_METHOD]);

    const { result } = renderHook(() => useChatArchiveSupported(), {
      wrapper: SessionWrapper,
    });

    expect(result.current).toBe(true);
  });

  it("checks tri-state support against the Epic session host", () => {
    recordNegotiatedHostMethods("unrelated-default-host", [
      SET_CHAT_ARCHIVED_METHOD,
    ]);
    recordNegotiatedHostMethods(SESSION_HOST_ID, []);

    const { result } = renderHook(() => useChatArchiveSupportState(), {
      wrapper: SessionWrapper,
    });

    expect(result.current).toBe(false);
  });

  it("keeps tri-state support unknown until the session host negotiates", () => {
    const { result } = renderHook(() => useChatArchiveSupportState(), {
      wrapper: SessionWrapper,
    });

    expect(result.current).toBeNull();
  });
});
