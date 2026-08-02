import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import {
  __resetSupportContextRegistryForTests,
  getSupportContextSnapshot,
  knownField,
  setSupportContextSnapshot,
} from "@/lib/support-context-registry";

afterEach(() => {
  cleanup();
  __resetSupportContextRegistryForTests();
});

describe("support-context registry", () => {
  it("starts every field unavailable", () => {
    const snapshot = getSupportContextSnapshot();
    expect(snapshot.hostId).toEqual({ status: "unavailable" });
    expect(snapshot.routeTemplate).toEqual({ status: "unavailable" });
    expect(snapshot.providerVersion).toEqual({ status: "unavailable" });
  });

  it("merges a partial snapshot patch without clobbering other fields", () => {
    setSupportContextSnapshot({ hostId: knownField("host-1") });
    setSupportContextSnapshot({ epicId: knownField("epic-1") });

    expect(getSupportContextSnapshot().hostId).toEqual(knownField("host-1"));
    expect(getSupportContextSnapshot().epicId).toEqual(knownField("epic-1"));
  });

  it("survives the unmount of the subtree that wrote it (module store, not React context)", () => {
    function WritesOnMount(): null {
      useEffect(() => {
        setSupportContextSnapshot({
          hostId: knownField("host-abc"),
          epicId: knownField("epic-1"),
        });
      }, []);
      return null;
    }

    const { unmount } = render(<WritesOnMount />);
    expect(getSupportContextSnapshot().hostId).toEqual(knownField("host-abc"));

    // Simulates a root crash: `RootErrorBoundary` unmounts the entire
    // authenticated-runtime subtree that wrote this registry. A registry
    // backed by React context would lose its value at this exact point,
    // since the context provider is torn down along with the subtree; the
    // module-scoped Zustand store (critique D5) must not.
    unmount();

    expect(getSupportContextSnapshot().hostId).toEqual(knownField("host-abc"));
    expect(getSupportContextSnapshot().epicId).toEqual(knownField("epic-1"));
  });
});
