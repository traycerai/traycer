import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentPickerModel } from "@/components/settings/environment/use-environment-picker-model";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

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

const OLD_LAPTOP: EnvironmentPick = {
  kind: "local",
  hostId: "old",
  hostName: "Old laptop",
};
const scope = hostScopeFixture({
  host: hostScopeOptionFixture({ hostId: "old", name: "Old laptop" }),
});
const stillLocal = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
  setup: { stage: "moving_settings", state: "awaiting_consent" },
});
const moved = environmentStatusFixture({
  setup: { stage: "done", state: "done" },
});

afterEach(() => {
  cleanup();
  facts.statuses = new Map();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: { kind: "unresolved" },
    defaultHostId: null,
    staleLocalHostIds: [],
  });
});

describe("useEnvironmentPickerModel's pick", () => {
  it("reads a stale Local pick as the default on the first render, and leaves it stored", () => {
    facts.statuses = new Map([["old", moved]]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const picks: EnvironmentPick[] = [];
    renderHook(() => {
      const model = useEnvironmentPickerModel(scope);
      picks.push(model.pick);
      return model;
    });
    expect(picks[0]).toEqual({ kind: "personal" });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(OLD_LAPTOP);
  });

  it("keeps a Local pick while its computer still has a Local row", () => {
    facts.statuses = new Map([["old", stillLocal]]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const { result } = renderHook(() => useEnvironmentPickerModel(scope));
    expect(result.current.pick).toEqual(OLD_LAPTOP);
  });

  it("keeps a Local pick before its computer has answered", () => {
    facts.statuses = new Map([["old", null]]);
    useSettingsEnvironmentPickStore.setState({ pick: OLD_LAPTOP });
    const { result } = renderHook(() => useEnvironmentPickerModel(scope));
    expect(result.current.pick).toEqual(OLD_LAPTOP);
  });
});
