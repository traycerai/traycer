import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-a";
const BINDING: EnvironmentHostBinding = {
  hostId: HOST_ID,
  environment: {
    environmentId: "env-personal",
    ownerKind: "user",
    ownerId: "user-a",
    roomId: "room-a",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      {props.children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("useEnvironmentHostReadQuery without a pool", () => {
  it("returns own_settings for a Local host and never sends environment.host.read", async () => {
    const reads: string[] = [];
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: null,
            planes: { records: "local", broker: "local", room: "local" },
          }),
        "environment.host.read": () => {
          reads.push(HOST_ID);
          return { ...BINDING, sharingGeneration: null };
        },
      },
    });
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
    });

    const { result } = renderHook(
      () => useEnvironmentHostReadQuery(client, HOST_ID, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.kind).toBe("own_settings"));
    expect(reads).toEqual([]);
  });

  it("returns the Personal binding when status says the host is not Local", async () => {
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({ principal: { kind: "personal" } }),
        "environment.host.read": () => ({
          ...BINDING,
          sharingGeneration: null,
        }),
      },
    });
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
    });

    const { result } = renderHook(
      () => useEnvironmentHostReadQuery(client, HOST_ID, true),
      { wrapper },
    );

    await waitFor(() => {
      const read = result.current;
      if (read.kind !== "binding") throw new Error("Expected binding");
      expect(read.query.data).toEqual({ ...BINDING, sharingGeneration: null });
    });
  });
});
