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
  SET_CHAT_SHARING_DEFAULT_METHOD,
  SET_CLOUD_CHAT_VISIBILITY_METHOD,
  useChatSharingDefaultSupported,
  useCloudChatVisibilitySupported,
} from "@/hooks/epic/use-chat-sharing-support";

const SESSION_HOST_ID = "epic-session-host-sharing";
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
    epicId: "epic-sharing-support-test",
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

describe("chat sharing capability routing", () => {
  it("checks per-chat visibility support against the Epic session host", () => {
    recordNegotiatedHostMethods("unrelated-default-host", []);
    recordNegotiatedHostMethods(SESSION_HOST_ID, [
      SET_CLOUD_CHAT_VISIBILITY_METHOD,
    ]);

    const { result } = renderHook(() => useCloudChatVisibilitySupported(), {
      wrapper: SessionWrapper,
    });

    expect(result.current).toBe(true);
  });

  it("hides the per-chat affordance when the session host does not advertise it", () => {
    recordNegotiatedHostMethods("unrelated-default-host", [
      SET_CLOUD_CHAT_VISIBILITY_METHOD,
    ]);
    recordNegotiatedHostMethods(SESSION_HOST_ID, []);

    const { result } = renderHook(() => useCloudChatVisibilitySupported(), {
      wrapper: SessionWrapper,
    });

    expect(result.current).toBe(false);
  });

  it("checks master-toggle support against the Epic session host", () => {
    recordNegotiatedHostMethods(SESSION_HOST_ID, [
      SET_CHAT_SHARING_DEFAULT_METHOD,
    ]);

    const { result } = renderHook(() => useChatSharingDefaultSupported(), {
      wrapper: SessionWrapper,
    });

    expect(result.current).toBe(true);
  });

  it("fails closed until the session host negotiates", () => {
    const visibility = renderHook(() => useCloudChatVisibilitySupported(), {
      wrapper: SessionWrapper,
    });
    const sharingDefault = renderHook(() => useChatSharingDefaultSupported(), {
      wrapper: SessionWrapper,
    });

    expect(visibility.result.current).toBe(false);
    expect(sharingDefault.result.current).toBe(false);
  });
});
