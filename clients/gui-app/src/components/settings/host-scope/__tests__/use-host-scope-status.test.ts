import { describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  deriveHostScopeStatus,
  hostListReadiness,
  isHostScopeUsable,
  type HostScopeStatus,
} from "@/components/settings/host-scope/host-scope-status";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";

/**
 * The status machine is the safety contract of the whole settings host scope:
 * every "may this panel read through a client, and which one" decision reduces
 * to its return value.
 *
 * Nothing else covered it. Every panel suite mocks `useHostScope` wholesale
 * with a fixture pinned to `following`, so the derivation never ran in a test —
 * which is how a `vanished` scope came to resolve as this computer's host, and
 * how a signed-out client came to render a spinner that could never resolve.
 */

// A REAL client, not a cast. The derivation only branches on its presence, so
// a stub would do behaviourally — but a chained `as unknown as` assertion is
// exactly what this repo's lint forbids, in tests as much as in production,
// and constructing the real thing over a mock messenger costs three lines.
const SOME_CLIENT: HostClient<HostRpcRegistry> =
  new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-status-test",
      handlers: {},
    }),
  });

const CONNECTABLE = hostScopeOptionFixture({
  hostId: "host-b",
  connectable: true,
});
const UNROUTABLE = hostScopeOptionFixture({
  hostId: "host-c",
  connectable: false,
});

interface DeriveOverrides {
  readonly isFollowing: boolean | undefined;
  readonly host: HostScopeOption | null | undefined;
  readonly vanishedHostId: string | null | undefined;
  readonly overrideClient: HostClient<HostRpcRegistry> | null | undefined;
  readonly hasRequestAuthority: boolean | undefined;
  readonly listsResolved: boolean | undefined;
}

function derive(overrides: Partial<DeriveOverrides>): HostScopeStatus {
  return deriveHostScopeStatus({
    isFollowing: overrides.isFollowing ?? false,
    host: overrides.host === undefined ? CONNECTABLE : overrides.host,
    vanishedHostId: overrides.vanishedHostId ?? null,
    overrideClient:
      overrides.overrideClient === undefined
        ? SOME_CLIENT
        : overrides.overrideClient,
    hasRequestAuthority: overrides.hasRequestAuthority ?? true,
    listsResolved: overrides.listsResolved ?? true,
  });
}

describe("hostListReadiness", () => {
  const ANSWERED = { hasData: true, isError: false };
  const PENDING = { hasData: false, isError: false };
  const FAILED = { hasData: false, isError: true };

  it("treats a rejected list as settled, not as perpetual loading", () => {
    // The regression this exists for: a failed request left `resolved` false
    // forever, so a pinned host that was genuinely gone could never be called
    // `vanished` and spun until the app restarted.
    expect(hostListReadiness(FAILED, ANSWERED)).toEqual({
      resolved: true,
      failed: true,
    });
  });

  it("is unresolved while either list is still pending", () => {
    expect(hostListReadiness(PENDING, ANSWERED).resolved).toBe(false);
    expect(hostListReadiness(ANSWERED, PENDING).resolved).toBe(false);
  });

  it("separates a clean empty answer from a failure", () => {
    // Both produce no hosts. Only one of them may say "No hosts yet".
    expect(hostListReadiness(ANSWERED, ANSWERED)).toEqual({
      resolved: true,
      failed: false,
    });
    expect(hostListReadiness(ANSWERED, FAILED).failed).toBe(true);
  });

  it("reports a failure even while the other list is still in flight", () => {
    expect(hostListReadiness(FAILED, PENDING)).toEqual({
      resolved: false,
      failed: true,
    });
  });
});

describe("deriveHostScopeStatus", () => {
  it("reports vanished before anything else, even when a host resolved", () => {
    // Precedence matters: a stale `host` alongside a vanished id must not be
    // read as usable. This ordering is what stops an administration surface
    // silently re-pointing at a machine the user never chose.
    expect(
      derive({ vanishedHostId: "gone", host: CONNECTABLE, isFollowing: true }),
    ).toBe("vanished");
  });

  it("is not usable while vanished", () => {
    expect(isHostScopeUsable(derive({ vanishedHostId: "gone" }))).toBe(false);
  });

  it("distinguishes a cold load from a resolved empty account", () => {
    // Both have no host. Only one of them is an answer.
    expect(derive({ host: null, listsResolved: false })).toBe("connecting");
    expect(derive({ host: null, listsResolved: true })).toBe("unreachable");
  });

  it("calls an unroutable host unreachable, never connecting", () => {
    // Terminal, not pending: no route exists and none is being built, so a
    // spinner here would never resolve.
    expect(derive({ host: UNROUTABLE, overrideClient: null })).toBe(
      "unreachable",
    );
  });

  it("treats a missing credential as unreachable rather than connecting", () => {
    // The transient client is built synchronously, so a connectable host with
    // no client means no request context / no bound user — signed out. This
    // rendered "Connecting to X…" forever before.
    expect(derive({ overrideClient: null, hasRequestAuthority: false })).toBe(
      "unreachable",
    );
  });

  it("still reports connecting when authority exists but the client does not", () => {
    expect(derive({ overrideClient: null, hasRequestAuthority: true })).toBe(
      "connecting",
    );
  });

  it("reports ready only with a resolved client on a connectable host", () => {
    expect(derive({ overrideClient: SOME_CLIENT })).toBe("ready");
    expect(isHostScopeUsable("ready")).toBe(true);
  });

  it("reports following when the scoped host is the active one", () => {
    expect(derive({ isFollowing: true })).toBe("following");
    expect(isHostScopeUsable("following")).toBe(true);
  });

  it("refuses to follow an active host whose route went unavailable", () => {
    // The active host keeps its id when its directory entry flips to
    // `unavailable`, so `isFollowing` stays true. Answering `following` first
    // let the ACTIVE host alone bypass the availability rule the model applies
    // to every other row: `connectable` was correctly false and RPC panels
    // mounted regardless, on the ambient client, against a route the transport
    // refuses. `following` is a claim about the CLIENT, not about the pick.
    expect(derive({ isFollowing: true, host: UNROUTABLE })).toBe("unreachable");
  });

  it("marks exactly the two client-bearing states usable", () => {
    // The list is the contract: adding a state must force a decision here
    // rather than defaulting into "usable".
    expect(
      (["following", "connecting", "unreachable", "vanished", "ready"] as const)
        .filter(isHostScopeUsable)
        .slice(),
    ).toEqual(["following", "ready"]);
  });
});
