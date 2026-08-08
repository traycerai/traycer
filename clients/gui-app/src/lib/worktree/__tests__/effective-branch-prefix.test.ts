import { describe, expect, it } from "vitest";
import { resolveEffectiveBranchPrefix } from "@/lib/worktree/effective-branch-prefix";

const WORKSPACE_PATH = "/repos/app";

describe("resolveEffectiveBranchPrefix", () => {
  it("inherits the global prefix when the repo override is absent", () => {
    expect(
      resolveEffectiveBranchPrefix(
        { status: "absent" },
        "traycer/",
        WORKSPACE_PATH,
      ),
    ).toEqual({
      value: "traycer/",
      source: "global",
      warning: null,
    });
  });

  it("falls back to global with a warning when the environment file is malformed", () => {
    const result = resolveEffectiveBranchPrefix(
      { status: "malformed" },
      "feat/",
      WORKSPACE_PATH,
    );
    expect(result.value).toBe("feat/");
    expect(result.source).toBe("global");
    expect(result.warning).toContain("malformed");
    expect(result.warning).toContain(
      `${WORKSPACE_PATH}/.traycer/environment.json`,
    );
  });

  it("uses a valid present repo override over the global default", () => {
    expect(
      resolveEffectiveBranchPrefix(
        { status: "present", value: "team/" },
        "traycer/",
        WORKSPACE_PATH,
      ),
    ).toEqual({
      value: "team/",
      source: "repo",
      warning: null,
    });
  });

  it("treats a present empty string as a deliberate no-prefix override", () => {
    expect(
      resolveEffectiveBranchPrefix(
        { status: "present", value: "" },
        "traycer/",
        WORKSPACE_PATH,
      ),
    ).toEqual({
      value: "",
      source: "repo",
      warning: null,
    });
  });

  it("falls back to global with a warning when a present value fails validation", () => {
    const result = resolveEffectiveBranchPrefix(
      { status: "present", value: "has spaces" },
      "traycer/",
      WORKSPACE_PATH,
    );
    expect(result.value).toBe("traycer/");
    expect(result.source).toBe("global");
    expect(result.warning).toContain("has spaces");
    expect(result.warning).toContain("invalid");
    expect(result.warning).toContain(
      `${WORKSPACE_PATH}/.traycer/environment.json`,
    );
  });
});
