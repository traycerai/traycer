import { describe, expect, it } from "vitest";
import {
  consumeArtifactEditorFocus,
  requestArtifactEditorFocus,
} from "@/lib/artifacts/pending-editor-focus";

describe("pending-editor-focus", () => {
  it("returns false for an artifact that was never requested", () => {
    expect(consumeArtifactEditorFocus("never-requested", "tab-1")).toBe(false);
  });

  it("consumes a request exactly once", () => {
    requestArtifactEditorFocus("artifact-1", "tab-1");
    expect(consumeArtifactEditorFocus("artifact-1", "tab-1")).toBe(true);
    expect(consumeArtifactEditorFocus("artifact-1", "tab-1")).toBe(false);
  });

  it("scopes requests per artifact id", () => {
    requestArtifactEditorFocus("artifact-a", "tab-1");
    expect(consumeArtifactEditorFocus("artifact-b", "tab-1")).toBe(false);
    expect(consumeArtifactEditorFocus("artifact-a", "tab-1")).toBe(true);
  });

  it("scopes requests per tab instance id", () => {
    requestArtifactEditorFocus("artifact-a", "tab-a");
    expect(consumeArtifactEditorFocus("artifact-a", "tab-b")).toBe(false);
    expect(consumeArtifactEditorFocus("artifact-a", "tab-a")).toBe(true);
  });
});
