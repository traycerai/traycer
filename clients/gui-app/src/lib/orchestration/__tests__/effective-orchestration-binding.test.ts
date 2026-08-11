import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useOrchestrationBindingStore,
  type OrchestrationBinding,
} from "@/stores/orchestration/orchestration-binding-store";
import { useOrchestrationEpicOverridesStore } from "@/stores/orchestration/orchestration-epic-overrides-store";
import { effectiveOrchestrationBinding } from "../effective-orchestration-binding";

const GLOBAL: OrchestrationBinding = {
  enabled: true,
  orchestrationName: "dev-team",
  roleId: "orchestrator",
  modelGroup: null,
};

const OVERRIDE: OrchestrationBinding = {
  enabled: true,
  orchestrationName: "x",
  roleId: "y",
  modelGroup: "cheap",
};

beforeEach(() => {
  window.localStorage.clear();
  useOrchestrationEpicOverridesStore.getState().resetForTests();
  useOrchestrationBindingStore.getState().setBinding(GLOBAL);
});

afterEach(() => {
  window.localStorage.clear();
  useOrchestrationEpicOverridesStore.getState().resetForTests();
  useOrchestrationBindingStore.getState().setBinding(GLOBAL);
});

describe("effectiveOrchestrationBinding", () => {
  it("null epicId always returns the global binding", () => {
    useOrchestrationEpicOverridesStore
      .getState()
      .setEpicOverride("epic-1", OVERRIDE);
    expect(effectiveOrchestrationBinding(null)).toEqual(GLOBAL);
  });

  it("override wins when present for the epic", () => {
    useOrchestrationEpicOverridesStore
      .getState()
      .setEpicOverride("epic-1", OVERRIDE);
    expect(effectiveOrchestrationBinding("epic-1")).toEqual(OVERRIDE);
  });

  it("falls back to global when epic has no override", () => {
    expect(effectiveOrchestrationBinding("epic-1")).toEqual(GLOBAL);
  });

  it("cleared override restores global fallback", () => {
    useOrchestrationEpicOverridesStore
      .getState()
      .setEpicOverride("epic-1", OVERRIDE);
    useOrchestrationEpicOverridesStore.getState().clearEpicOverride("epic-1");
    expect(effectiveOrchestrationBinding("epic-1")).toEqual(GLOBAL);
  });
});
