import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentPickerModel } from "@/components/settings/environment/use-environment-picker-model";
import { useEnvironmentSectionShown } from "@/components/settings/environment/use-environment-section-shown";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import {
  PERSONAL_PICK,
  UNRESOLVED_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  useEnvironmentPick,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";

const facts = vi.hoisted(
  (): { statuses: Map<string, EnvironmentStatusResponseV11 | null> } => ({
    statuses: new Map(),
  }),
);
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => facts.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => new Map(),
}));
// The window's host does not run Personal, so Personal reads the cloud and
// lists Secrets; a Local pick lists it where its listed computer serves it.
vi.mock("@/components/settings/personal/use-window-host-runs-personal", () => ({
  useWindowHostRunsPersonal: () => ({ runs: false }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

const OLD_LAPTOP: EnvironmentPick = {
  kind: "local",
  hostId: "old",
  hostName: "Old laptop",
};
const oldLaptop = hostScopeOptionFixture({ hostId: "old", name: "Old laptop" });
const mac = hostScopeOptionFixture({ hostId: "mac", name: "MacBook Pro" });
/** This window is the MacBook, and the account lists the old laptop too. */
const listingOld = hostScopeFixture({ host: mac, hosts: [mac, oldLaptop] });
/** The account no longer lists the old laptop. */
const withoutOld = hostScopeFixture({ host: mac });
const stillLocal = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
  setup: { stage: "moving_settings", state: "awaiting_consent" },
});
const moved = environmentStatusFixture({
  setup: { stage: "done", state: "done" },
});
const running = environmentStatusFixture({ principal: { kind: "personal" } });

/** What the dropdown, a page and the rail's Secrets filter read, side by side. */
function renderReaders(initial: HostScope) {
  return renderHook(
    (props: { readonly scope: HostScope }) => ({
      dropdown: useEnvironmentPickerModel(props.scope).pick,
      page: useEnvironmentPick(),
      secretsListed: useEnvironmentSectionShown(props.scope)("secrets"),
    }),
    { initialProps: { scope: initial } },
  );
}

beforeEach(() => {
  useSelectionAuthorityStore.setState({ effectiveHostId: "mac" });
});

afterEach(() => {
  cleanup();
  facts.statuses = new Map();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: UNRESOLVED_PICK,
    defaultHostId: null,
    gone: null,
  });
  useSelectionAuthorityStore.getState().reset();
});

describe("useEnvironmentPickerModel's pick", () => {
  it("reads a stale Local pick as the default on the first render, and leaves it stored", () => {
    facts.statuses = new Map([
      ["mac", running],
      ["old", moved],
    ]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const picks: EnvironmentPick[] = [];
    renderHook(() => {
      const model = useEnvironmentPickerModel(listingOld);
      picks.push(model.pick);
      return model;
    });
    expect(picks[0]).toEqual({ kind: "personal" });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(OLD_LAPTOP);
  });

  it("keeps a Local pick while its computer still has a Local row", () => {
    facts.statuses = new Map([
      ["mac", running],
      ["old", stillLocal],
    ]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const { result } = renderReaders(listingOld);
    expect(result.current).toEqual({
      dropdown: OLD_LAPTOP,
      page: OLD_LAPTOP,
      secretsListed: true,
    });
  });

  it("keeps a Local pick before its computer has answered", () => {
    facts.statuses = new Map([
      ["mac", running],
      ["old", null],
    ]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const { result } = renderReaders(listingOld);
    expect(result.current).toEqual({
      dropdown: OLD_LAPTOP,
      page: OLD_LAPTOP,
      secretsListed: true,
    });
  });

  it("stays on the default once its computer has moved, after that computer has its own settings again", () => {
    facts.statuses = new Map([
      ["mac", running],
      ["old", moved],
    ]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const view = renderReaders(listingOld);
    expect(view.result.current.dropdown).toEqual(PERSONAL_PICK);

    facts.statuses = new Map([
      ["mac", running],
      ["old", stillLocal],
    ]);
    view.rerender({ scope: listingOld });
    expect(view.result.current).toEqual({
      dropdown: PERSONAL_PICK,
      page: PERSONAL_PICK,
      secretsListed: true,
    });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(OLD_LAPTOP);
  });

  it("stays on the default with Secrets listed once a moved computer leaves the account", () => {
    facts.statuses = new Map([
      ["mac", running],
      ["old", moved],
    ]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const view = renderReaders(listingOld);
    expect(view.result.current.dropdown).toEqual(PERSONAL_PICK);

    facts.statuses = new Map([["mac", running]]);
    view.rerender({ scope: withoutOld });
    expect(view.result.current).toEqual({
      dropdown: PERSONAL_PICK,
      page: PERSONAL_PICK,
      secretsListed: true,
    });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(OLD_LAPTOP);
  });
});
