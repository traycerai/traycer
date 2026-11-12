import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import type {
  EnvironmentDescriptorV11,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import { useProfileSignInEnvironment } from "@/hooks/providers/use-profile-sign-in-environment";
import {
  PersonalPageContext,
  type PersonalPageContextValue,
} from "@/components/settings/personal/personal-page-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";

const HOST_ID = "host-a";
const PERSONAL: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "viewer",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};
const BINDING: EnvironmentHostBinding = {
  hostId: HOST_ID,
  environment: {
    environmentId: PERSONAL.environmentId,
    ownerKind: PERSONAL.ownerKind,
    ownerId: PERSONAL.ownerId,
    roomId: PERSONAL.roomId,
    label: PERSONAL.label,
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};
let statusAnswers: ReadonlyArray<EnvironmentStatusResponseV12> = [];
let bindingFails = false;

function personalPageValue(
  client: PersonalPageContextValue["client"],
): PersonalPageContextValue {
  return {
    section: "providers",
    pick: PERSONAL_PICK,
    state: { kind: "ready", status: localStatus() },
    line: null,
    hostName: "This computer",
    localOverrides: [],
    hostId: HOST_ID,
    client,
    notices: [],
    review: [],
  };
}

function localStatus() {
  return environmentStatusFixture({
    principal: { kind: "personal" },
    planes: { records: "local", broker: "local", room: "local" },
  });
}

function wrapperFor(page: PersonalPageContextValue | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <PersonalPageContext.Provider value={page}>
        {props.children}
      </PersonalPageContext.Provider>
    </QueryClientProvider>
  );
}

function buildClient() {
  const requests = { status: 0, binding: 0, list: 0 };
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () => {
        const answer = statusAnswers[requests.status] ?? localStatus();
        requests.status += 1;
        return answer;
      },
      "environment.host.read": () => {
        requests.binding += 1;
        if (bindingFails)
          return Promise.reject(new Error("binding unavailable"));
        return { ...BINDING, sharingGeneration: null };
      },
      "environment.list": () => {
        requests.list += 1;
        return { environments: [PERSONAL] };
      },
    },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
    "environment.host.read": { major: 1, minor: 1 },
    "environment.list": { major: 1, minor: 1 },
  });
  return { client, requests };
}

beforeEach(() => {
  settleProcessHostRpcTierPlan(null);
  statusAnswers = [];
  bindingFails = false;
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "viewer", username: "viewer" },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useProfileSignInEnvironment", () => {
  it("names Personal from environment.list on a Local computer in the Personal page", async () => {
    const { client, requests } = buildClient();
    const { result } = renderHook(() => useProfileSignInEnvironment(client), {
      wrapper: wrapperFor(personalPageValue(client)),
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        kind: "environment",
        environmentId: PERSONAL.environmentId,
        canSignIn: true,
      });
    });
    expect(requests.list).toBe(1);
    expect(requests.status).toBe(0);
    expect(requests.binding).toBe(0);
  });

  it("answers local outside the Personal page without reading the binding", async () => {
    const { client, requests } = buildClient();
    const { result } = renderHook(() => useProfileSignInEnvironment(client), {
      wrapper: wrapperFor(null),
    });

    await waitFor(() => expect(result.current).toEqual({ kind: "local" }));
    expect(requests.status).toBeGreaterThan(0);
    expect(requests.binding).toBe(0);
    expect(requests.list).toBe(0);
  });

  it("rechecks status after a failed binding and answers local", async () => {
    statusAnswers = [
      environmentStatusFixture({ principal: { kind: "personal" } }),
      localStatus(),
    ];
    bindingFails = true;
    const { client, requests } = buildClient();
    const { result } = renderHook(() => useProfileSignInEnvironment(client), {
      wrapper: wrapperFor(null),
    });

    await waitFor(() => {
      expect(result.current.kind).toBe("failed");
    });
    expect(requests.status).toBe(1);
    expect(requests.binding).toBe(1);

    const failed = result.current;
    if (failed.kind !== "failed") throw new Error("Expected failed binding");
    failed.retry();

    await waitFor(() => {
      expect(result.current).toEqual({ kind: "local" });
    });
    expect(requests.status).toBe(2);
  });
});
