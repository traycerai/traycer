import { expect, it } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

it("waits for an explicit discovery answer before serving an empty fleet from the pool", () => {
  const authority = mountTestSelectionAuthority({
    hosts: [],
    discovery: "pending",
  });
  expect(useSelectionAuthorityStore.getState().servingPeer).toBeNull();
  authority.publishFleet([], null);
  expect(useSelectionAuthorityStore.getState()).toMatchObject({
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    servingPeer: { kind: "pool" },
    leases: [],
  });
});

it("rejects a seed fleet before discovery has answered", () => {
  expect(() =>
    mountTestSelectionAuthority({
      hosts: [{ hostId: "computer-a", kind: "remote", teamOwned: false }],
      discovery: "pending",
    }),
  ).toThrow("Pending discovery requires an empty fleet and no local host");
});

it("keeps the reserved pool outside computer inputs and requires a pool address", () => {
  const reservedRow = {
    hostId: POOL_HOST_ID,
    kind: "remote",
    teamOwned: false,
  } as const;
  const reservedIdMessage =
    "The reserved pool id is a serving peer, never a computer";
  expect(() => mountTestSelectionAuthority({ hosts: [reservedRow] })).toThrow(
    reservedIdMessage,
  );
  expect(() =>
    mountTestSelectionAuthority({ hosts: [], localHostId: POOL_HOST_ID }),
  ).toThrow(reservedIdMessage);
  const authority = mountTestSelectionAuthority({
    hosts: [],
    pool: "disabled",
  });
  expect(() => authority.publishFleet([reservedRow], null)).toThrow(
    reservedIdMessage,
  );
  expect(() => authority.connectComputer(POOL_HOST_ID)).toThrow(
    reservedIdMessage,
  );
  expect(() => authority.openPool()).toThrow("The pool is not configured");
  expect(useSelectionAuthorityStore.getState().servingPeer).toBeNull();
});
