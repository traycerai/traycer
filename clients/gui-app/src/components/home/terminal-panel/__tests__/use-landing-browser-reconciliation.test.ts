import { describe, expect, it } from "vitest";
import {
  landingTabRefKey,
  type LandingBrowserTabRef,
} from "@/stores/home/landing-panel-store";
import {
  epicScope,
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  defaultLandingBrowserTitle,
  reconcileLandingBrowserTabs,
  type LandingBrowserReconciliationInput,
} from "../use-landing-browser-reconciliation";

const HOST_ID = "host-a";

function browserTabRef(
  overrides: Partial<LandingBrowserTabRef>,
): LandingBrowserTabRef {
  return {
    kind: "browser",
    instanceId: "instance-1",
    sessionId: "session-1",
    hostId: HOST_ID,
    tabId: "tab-1",
    name: "Stored Name",
    titleSource: "default",
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<LandingBrowserReconciliationInput>,
): LandingBrowserReconciliationInput {
  return {
    tabs: [],
    hostId: HOST_ID,
    sessions: [],
    excludedTabKeys: new Set<string>(),
    // Most scenarios below expect no adoption at all; a scenario that DOES
    // expect one overrides this, so a stray call here is a bug surfacing
    // loudly instead of a silent, wrong instance id.
    mintInstanceId: (): string => {
      throw new Error("mintInstanceId should not be called in this scenario");
    },
    ...overrides,
  };
}

describe("reconcileLandingBrowserTabs", () => {
  it("adopts a tab present in the host's snapshot with no matching store ref", () => {
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example Page",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({
        sessions: [session],
        mintInstanceId: () => "minted-instance-1",
      }),
    );

    const adopted: LandingBrowserTabRef = {
      kind: "browser",
      instanceId: "minted-instance-1",
      hostId: HOST_ID,
      sessionId: "session-1",
      tabId: "tab-1",
      name: "Example Page",
      titleSource: "default",
    };
    expect(result.adoptedTabs).toEqual([adopted]);
    expect(result.tabs).toEqual([adopted]);
    expect(result.removedInstanceIds).toEqual([]);
    expect(result.collapseWhenEmpty).toBe(false);
  });

  it("drops a store ref absent from a ready snapshot", () => {
    const ref = browserTabRef({ instanceId: "gone-instance" });

    const result = reconcileLandingBrowserTabs(
      baseInput({ tabs: [ref], sessions: [] }),
    );

    expect(result.tabs).toEqual([]);
    expect(result.removedInstanceIds).toEqual(["gone-instance"]);
    expect(result.collapseWhenEmpty).toBe(true);
    expect(result.adoptedTabs).toEqual([]);
  });

  it("keeps a manual title untouched but re-syncs a default one to the live title", () => {
    const manualRef = browserTabRef({
      instanceId: "manual-instance",
      tabId: "tab-manual",
      name: "My Custom Name",
      titleSource: "manual",
    });
    const defaultRef = browserTabRef({
      instanceId: "default-instance",
      tabId: "tab-default",
      name: "Stale Title",
      titleSource: "default",
    });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-manual",
          title: "Different Live Title",
          url: "https://manual.example/",
        }),
        tabInfo({
          tabId: "tab-default",
          title: "Fresh Title",
          url: "https://default.example/",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({ tabs: [manualRef, defaultRef], sessions: [session] }),
    );

    const manualResult = result.tabs.find(
      (tab) => tab.instanceId === "manual-instance",
    );
    const defaultResult = result.tabs.find(
      (tab) => tab.instanceId === "default-instance",
    );
    expect(manualResult?.name).toBe("My Custom Name");
    expect(defaultResult?.name).toBe("Fresh Title");
  });

  it("drops a tombstoned tab and does not re-adopt it even though the snapshot still lists it", () => {
    // The regression this pins: a tombstoned tab is still in the host's
    // inventory until the close lands, so "absent from the snapshot" is NOT
    // what keeps it out of the panel - the exclusion set is.
    const ref = browserTabRef({ instanceId: "tombstoned-instance" });
    const key = landingTabRefKey(ref);
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Still Open On The Host",
          url: "https://example.com/",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({
        tabs: [ref],
        sessions: [session],
        excludedTabKeys: new Set([key]),
      }),
    );

    expect(result.tabs).toEqual([]);
    expect(result.adoptedTabs).toEqual([]);
    expect(result.removedInstanceIds).toEqual(["tombstoned-instance"]);
    expect(result.collapseWhenEmpty).toBe(true);
  });

  it("never adopts, and never treats as evidence of life, a session on a different host or an epic-scoped session on the same host", () => {
    // Both extra sessions below share this ref's sessionId/tabId on purpose:
    // `landingTabRefKey` builds the lookup key from `input.hostId`, not
    // `session.hostId`, so nothing but the initial host+scope filter stands
    // between a same-id foreign-host or epic-scoped session and a false
    // match that would incorrectly keep this ref alive.
    const ref = browserTabRef({
      instanceId: "existing-instance",
      sessionId: "shared-session-id",
      tabId: "shared-tab-id",
    });
    const foreignHostSession = sessionInfo({
      sessionId: "shared-session-id",
      hostId: "host-b",
      scope: independentScope(),
      tabs: [tabInfo({ tabId: "shared-tab-id" })],
    });
    const epicScopedSameHostSession = sessionInfo({
      sessionId: "shared-session-id",
      hostId: HOST_ID,
      scope: epicScope("epic-1"),
      tabs: [tabInfo({ tabId: "shared-tab-id" })],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({
        tabs: [ref],
        sessions: [foreignHostSession, epicScopedSameHostSession],
      }),
    );

    // Correctly gone: no independent, same-host session actually has it.
    expect(result.tabs).toEqual([]);
    expect(result.removedInstanceIds).toEqual(["existing-instance"]);
    expect(result.collapseWhenEmpty).toBe(true);
    // Neither the foreign-host nor the epic-scoped session contributed one.
    expect(result.adoptedTabs).toEqual([]);
  });

  it("keeps the same ref identity and reports no collapse when nothing changed", () => {
    const ref = browserTabRef({
      instanceId: "steady-instance",
      name: "Steady Title",
      titleSource: "default",
    });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Steady Title",
          url: "https://steady.example/",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({ tabs: [ref], sessions: [session] }),
    );

    expect(result.tabs).toEqual([ref]);
    expect(result.tabs.at(0)).toBe(ref);
    expect(result.collapseWhenEmpty).toBe(false);
    expect(result.removedInstanceIds).toEqual([]);
    expect(result.adoptedTabs).toEqual([]);
  });
});

describe("defaultLandingBrowserTitle", () => {
  it("falls back to the url when the live title is null", () => {
    expect(
      defaultLandingBrowserTitle({ title: null, url: "https://a.example/" }),
    ).toBe("https://a.example/");
  });

  it("falls back to the url when the live title is whitespace-only", () => {
    expect(
      defaultLandingBrowserTitle({ title: "   ", url: "https://b.example/" }),
    ).toBe("https://b.example/");
  });

  it("uses the live title when it is present", () => {
    expect(
      defaultLandingBrowserTitle({
        title: "Real Title",
        url: "https://c.example/",
      }),
    ).toBe("Real Title");
  });
});
