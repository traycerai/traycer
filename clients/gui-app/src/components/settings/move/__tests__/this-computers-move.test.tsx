import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { useThisComputersMove } from "@/components/settings/move/use-this-computers-move";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

/*
 * What the Getting started card and the Start page's invitation are asked:
 * has THIS computer got settings it could move? Every answer here comes from
 * the planes and the live move, never from `status.consent` - that consent is
 * the migration marker's, and the host keeps the marker when a person stops
 * sharing, so a computer sharing nothing carries one.
 */

const HOST_ID = "old";
const ACCEPTED_AT = Date.UTC(2026, 9, 20, 12);

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

/** The hook over a real `HostClient`, under the query client it needs. */
function renderMove(computer: ThisComputer): {
  readonly current: () => string;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(() => useThisComputersMove(computer, true), {
    wrapper: (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
  return { current: () => result.current };
}

/** This computer, with a host answering `environment.status` with `status`. */
function computerAnswering(status: EnvironmentStatusResponseV11): ThisComputer {
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: { "environment.status": () => status },
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
  });
  return { hostId: HOST_ID, hostName: "Old laptop", client };
}

async function settlesTo(
  status: EnvironmentStatusResponseV11,
  answer: string,
): Promise<void> {
  const move = renderMove(computerAnswering(status));
  await waitFor(() => expect(move.current()).toBe(answer));
}

describe("useThisComputersMove", () => {
  it("still has something to move after the person stopped sharing", async () => {
    // The marker is KEPT on `Stop sharing from this computer`, so the status
    // carries its consent while first start waits to be asked again. Keyed on
    // that consent, the Getting started card read `Complete` over a computer
    // sharing nothing - and counted the checklist done.
    await settlesTo(
      environmentStatusFixture({
        principal: { kind: "personal" },
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        consent: { acceptedAt: ACCEPTED_AT, planHash: "plan-1" },
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
      "not_moved",
    );
  });

  it("has something to move on a computer that never moved", async () => {
    await settlesTo(
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
        consent: null,
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
      "not_moved",
    );
  });

  it("stays quiet while a move is running, which reports no consent at all", async () => {
    // Past the accept: the Overview is showing the progress, so the card and
    // the toast have nothing to invite. `consent` is null right through the
    // upload, so this is also the case a consent key would have got backwards.
    await settlesTo(
      environmentStatusFixture({
        principal: { kind: "personal" },
        planes: { records: "moved", broker: "local", room: "local" },
        consent: null,
        setup: { stage: "moving_settings", state: "running" },
      }),
      "moved",
    );
  });

  it("stays quiet while a move that stopped waits for Retry", async () => {
    await settlesTo(
      environmentStatusFixture({
        principal: { kind: "personal" },
        planes: { records: "moved", broker: "local", room: "local" },
        consent: null,
        setup: { stage: "moving_settings", state: "failed" },
      }),
      "moved",
    );
  });

  it("has nothing to invite once every plane is in Personal", async () => {
    await settlesTo(
      environmentStatusFixture({
        principal: { kind: "personal" },
        consent: { acceptedAt: ACCEPTED_AT, planHash: "plan-1" },
        setup: { stage: "done", state: "done" },
      }),
      "moved",
    );
  });

  it("claims nothing from a computer with no host of its own", () => {
    const move = renderMove({
      hostId: null,
      hostName: "this computer",
      client: null,
    });

    expect(move.current()).toBe("unknown");
  });
});
