/**
 * Locks down the `identity` tab kind: registry membership, `build()`'s
 * display fields, and the descriptor's route/intent round trip.
 */
import { describe, expect, it } from "vitest";
import { identityTabModule } from "@/stores/tabs/kinds/identity";
import { isRegisteredTabKind } from "@/stores/tabs/registry";
import { identityTabIntent } from "@/lib/tab-navigation/intents";
import {
  identityPathname,
  identityRoute,
  readIdentityIdFromPath,
} from "@/lib/routes";
import type { IdentityTab } from "@/stores/identities/identity-tabs-store";

function identityTabSource(overrides: Partial<IdentityTab>): IdentityTab {
  return {
    id: "identity_1",
    identityId: "identity_1",
    hostId: "host-a",
    title: "",
    ...overrides,
  };
}

describe("identity tab kind - registry dispatch", () => {
  it("is registered", () => {
    expect(isRegisteredTabKind("identity")).toBe(true);
  });
});

describe("identity tab kind - build()", () => {
  it("builds the /identities/<id> route from the source identity id", () => {
    const tab = identityTabModule.build(
      identityTabSource({ identityId: "identity_42", title: "SOUL" }),
    );
    expect(tab.route).toBe(identityPathname("identity_42"));
    expect(tab.identityId).toBe("identity_42");
  });

  it("falls back to 'Identity' when the source title is empty", () => {
    const tab = identityTabModule.build(
      identityTabSource({ identityId: "identity_1", title: "" }),
    );
    expect(tab.name).toBe("Identity");
  });

  it("uses the source title verbatim when non-empty", () => {
    const tab = identityTabModule.build(
      identityTabSource({ identityId: "identity_1", title: "My Identity" }),
    );
    expect(tab.name).toBe("My Identity");
  });

  it("cannot be duplicated or opened in a new window", () => {
    const tab = identityTabModule.build(identityTabSource({}));
    expect(tab.canDuplicate).toBe(false);
    expect(tab.canOpenInNewWindow).toBe(false);
  });

  it("carries the host the tab is bound to", () => {
    const tab = identityTabModule.build(
      identityTabSource({ hostId: "host-b" }),
    );
    expect(tab.hostId).toBe("host-b");
  });
});

describe("identity tab kind - descriptor", () => {
  it("resolveIntent returns the identity intent for the tab's identity id", () => {
    const tab = identityTabModule.build(
      identityTabSource({ identityId: "identity_7" }),
    );
    expect(identityTabModule.descriptor.resolveIntent(tab)).toEqual(
      identityTabIntent("identity_7"),
    );
  });

  it("routeOptions for the identity intent matches identityRoute", () => {
    const intent = identityTabIntent("identity_7");
    expect(identityTabModule.descriptor.routeOptions(intent)).toEqual(
      identityRoute("identity_7"),
    );
  });

  it("matchesPath is true only for the tab's exact route", () => {
    const tab = identityTabModule.build(
      identityTabSource({ identityId: "identity_7" }),
    );
    expect(
      identityTabModule.descriptor.matchesPath(tab, "/identities/identity_7"),
    ).toBe(true);
    expect(
      identityTabModule.descriptor.matchesPath(tab, "/identities/other"),
    ).toBe(false);
    expect(identityTabModule.descriptor.matchesPath(tab, "/home")).toBe(false);
  });

  it("declares a non-duplicable, tab-host-scoped surface", () => {
    expect(identityTabModule.descriptor.surface.duplication).toBe("forbidden");
    expect(identityTabModule.descriptor.surface.readinessScope).toBe(
      "tab-host",
    );
    expect(identityTabModule.descriptor.surface.newWindow).toBe("none");
  });

  it("requiresCloseConfirm is false", () => {
    const tab = identityTabModule.build(identityTabSource({}));
    expect(identityTabModule.descriptor.requiresCloseConfirm(tab)).toBe(false);
  });
});

describe("readIdentityIdFromPath", () => {
  it("round-trips an identity id encoded into the route", () => {
    const encoded = "id with spaces/slash?";
    const route = identityRoute(encoded);
    // `identityRoute` returns TanStack params - build the literal pathname the
    // router would produce the same way `identityPathname` does, but through
    // an encoded id so the round trip exercises decoding.
    const pathname = `/identities/${encodeURIComponent(encoded)}`;
    expect(readIdentityIdFromPath(pathname)).toBe(encoded);
    expect(route.params).toEqual({ identityId: encoded });
  });

  it("returns null for a non-identity path", () => {
    expect(readIdentityIdFromPath("/home")).toBeNull();
    expect(readIdentityIdFromPath("/epics/epic-1")).toBeNull();
  });

  it("returns null for an identity path with no id segment", () => {
    expect(readIdentityIdFromPath("/identities/")).toBeNull();
  });
});
