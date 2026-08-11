import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
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

let sessionHandle: OpenEpicStoreHandle;

function SessionWrapper(props: { readonly children: ReactNode }): ReactNode {
  return createElement(
    EpicSessionContext.Provider,
    { value: sessionHandle },
    props.children,
  );
}

beforeEach(() => {
  resetNegotiatedManifests();
  sessionHandle = createOpenEpicStore({
    epicId: "epic-archive-support-test",
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
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
