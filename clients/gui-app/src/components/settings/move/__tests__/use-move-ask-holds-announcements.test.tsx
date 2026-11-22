import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { useMoveAskHoldsAnnouncements } from "@/components/settings/move/use-move-ask-holds-announcements";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const HOST_ID = "local-host";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useMoveSheetStore.getState().closeSheet();
  useOnboardingStore.setState({ moveInvitationAnswered: false });
  activeComputer = { hostId: null, hostName: "this computer", client: null };
});

function renderHold(
  computer: ThisComputer,
  enabled: boolean,
): {
  readonly current: () => boolean;
} {
  activeComputer = computer;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(() => useMoveAskHoldsAnnouncements(enabled), {
    wrapper: (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
  return { current: () => result.current };
}

/* These hooks use the same local-host boundaries as the neighboring move tests. */
let activeComputer: ThisComputer = {
  hostId: null,
  hostName: "this computer",
  client: null,
};

function computerAnswering(status: EnvironmentStatusResponseV13): ThisComputer {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: { "environment.status": () => status },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
  });
  return { hostId: HOST_ID, hostName: "This computer", client };
}

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => activeComputer.hostId,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => activeComputer.client,
  useHostDirectoryEntryForHostId: () => null,
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({ data: { hosts: [] } }),
}));

describe("useMoveAskHoldsAnnouncements", () => {
  it("holds while the move sheet is open even after the computer moved", async () => {
    const moved = computerAnswering(
      environmentStatusFixture({
        principal: { kind: "personal" },
        planes: { records: "moved", broker: "moved", room: "moved" },
      }),
    );
    const hold = renderHold(moved, true);
    await waitFor(() => expect(hold.current()).toBe(false));

    act(() => {
      useMoveSheetStore.getState().openSheet({
        hostId: HOST_ID,
        hostName: "This computer",
      });
    });
    expect(hold.current()).toBe(true);
  });

  it("holds while this computer's move status is pending", () => {
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => new Promise(() => undefined),
      },
    });
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
    });

    expect(
      renderHold(
        { hostId: HOST_ID, hostName: "This computer", client },
        true,
      ).current(),
    ).toBe(true);
  });

  it("holds for an unanswered move invitation", async () => {
    const hold = renderHold(
      computerAnswering(
        environmentStatusFixture({
          principal: { kind: "personal" },
          planes: { records: "local", broker: "local", room: "local" },
        }),
      ),
      true,
    );

    await waitFor(() => expect(hold.current()).toBe(true));
  });

  it("releases after the move invitation is answered", async () => {
    useOnboardingStore.setState({ moveInvitationAnswered: true });
    const hold = renderHold(
      computerAnswering(
        environmentStatusFixture({
          principal: { kind: "personal" },
          planes: { records: "local", broker: "local", room: "local" },
        }),
      ),
      true,
    );

    await waitFor(() => expect(hold.current()).toBe(false));
  });

  it("releases for moved, team-owned, and unknown computers", async () => {
    const moved = renderHold(
      computerAnswering(
        environmentStatusFixture({
          principal: { kind: "personal" },
          planes: { records: "moved", broker: "moved", room: "moved" },
        }),
      ),
      true,
    );
    await waitFor(() => expect(moved.current()).toBe(false));

    const team = renderHold(
      computerAnswering(
        environmentStatusFixture({
          principal: { kind: "team", teamName: "Designers" },
          planes: { records: "local", broker: "local", room: "local" },
        }),
      ),
      true,
    );
    await waitFor(() => expect(team.current()).toBe(false));

    expect(
      renderHold(
        { hostId: null, hostName: "this computer", client: null },
        true,
      ).current(),
    ).toBe(false);
  });

  it("releases when disabled", () => {
    expect(
      renderHold(
        computerAnswering(
          environmentStatusFixture({
            principal: { kind: "personal" },
            planes: { records: "local", broker: "local", room: "local" },
          }),
        ),
        false,
      ).current(),
    ).toBe(false);
  });
});
