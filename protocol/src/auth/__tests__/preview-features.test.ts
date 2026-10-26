import { describe, expect, it } from "vitest";
import {
  PREVIEW_FEATURES_OFF,
  previewFeatureState,
  readPreviewFeatures,
  type PreviewFeatures,
} from "@traycer/protocol/auth/preview-features";

const ALL_ON: PreviewFeatures = {
  environments: true,
  sandboxes: true,
  bots: true,
};

describe("readPreviewFeatures", () => {
  it.each([
    PREVIEW_FEATURES_OFF,
    { environments: true, sandboxes: false, bots: true },
    ALL_ON,
  ])("reads the supported verdict %j as itself", (verdict) => {
    expect(readPreviewFeatures(verdict)).toEqual(verdict);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a field that is not a boolean", { ...ALL_ON, sandboxes: 1 }],
    ["a field missing", { environments: true, sandboxes: true }],
    ["not an object", "environments,sandboxes,bots"],
    ["environments without bots", { ...ALL_ON, bots: false }],
    [
      "environments off with sandboxes on",
      { environments: false, sandboxes: true, bots: false },
    ],
    [
      "environments off with bots on",
      { environments: false, sandboxes: false, bots: true },
    ],
  ])("reads %s as off", (_label, raw) => {
    expect(readPreviewFeatures(raw)).toEqual(PREVIEW_FEATURES_OFF);
  });

  it("drops a key it does not know rather than refusing the verdict", () => {
    expect(readPreviewFeatures({ ...ALL_ON, automations: true })).toEqual(
      ALL_ON,
    );
  });
});

describe("previewFeatureState", () => {
  it("is unread before any read, whatever the feature", () => {
    expect(previewFeatureState({ kind: "unread" }, "environments")).toBe(
      "unread",
    );
  });

  it("is on or off per feature once a verdict is read", () => {
    const reading = {
      kind: "read" as const,
      verdict: { environments: true, sandboxes: false, bots: true },
    };
    expect(previewFeatureState(reading, "environments")).toBe("on");
    expect(previewFeatureState(reading, "sandboxes")).toBe("off");
    expect(
      previewFeatureState(
        { kind: "read", verdict: PREVIEW_FEATURES_OFF },
        "environments",
      ),
    ).toBe("off");
  });
});
