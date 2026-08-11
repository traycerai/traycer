import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestrationBinding } from "../orchestration-binding-store";
import { useOrchestrationEpicOverridesStore } from "../orchestration-epic-overrides-store";

const SAMPLE: OrchestrationBinding = {
  enabled: true,
  orchestrationName: "dev-team",
  roleId: "orchestrator",
  modelGroup: "cheap",
};

beforeEach(() => {
  window.localStorage.clear();
  useOrchestrationEpicOverridesStore.getState().resetForTests();
});

afterEach(() => {
  window.localStorage.clear();
  useOrchestrationEpicOverridesStore.getState().resetForTests();
});

describe("useOrchestrationEpicOverridesStore", () => {
  it("setEpicOverride writes the binding for that epic", () => {
    useOrchestrationEpicOverridesStore
      .getState()
      .setEpicOverride("epic-1", SAMPLE);
    expect(
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId["epic-1"],
    ).toEqual(SAMPLE);
  });

  it("clearEpicOverride removes the override", () => {
    useOrchestrationEpicOverridesStore
      .getState()
      .setEpicOverride("epic-1", SAMPLE);
    useOrchestrationEpicOverridesStore.getState().clearEpicOverride("epic-1");
    expect(
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId,
    ).toEqual({});
  });

  it("clearEpicOverride is a no-op when absent", () => {
    useOrchestrationEpicOverridesStore.getState().clearEpicOverride("missing");
    expect(
      useOrchestrationEpicOverridesStore.getState().overridesByEpicId,
    ).toEqual({});
  });
});
