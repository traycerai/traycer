import type {
  ProviderNativeScope,
  ProviderSkill,
  ProviderSkillInspectCandidate,
  ProviderSkillsCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import { describe, expect, it } from "vitest";
import {
  composerErrorMessage,
  isSkillSourceShaMismatch,
  previewSkillMd,
  preselectSkillNames,
  providerRootFromSkills,
  skillAuthoring,
  skillDestination,
  skillFilePath,
  skillNameError,
  skillNamesFromSourceFlags,
  skillProviderScopeVisible,
  skillSubmitBlocker,
} from "@/components/settings/panels/provider-skill-composer-model";

function capsWith(
  create: readonly ProviderNativeScope[],
  importScopes: readonly ProviderNativeScope[],
  inspect: readonly ProviderNativeScope[] | undefined,
): ProviderSkillsCapabilities {
  return {
    actionScopes: {
      list: ["global"],
      add: [],
      create: [...create],
      import: [...importScopes],
      remove: [],
      ...(inspect === undefined ? {} : { inspect: [...inspect] }),
    },
  };
}

describe("skillAuthoring", () => {
  it("opens both paths when both actions advertise the selected scope", () => {
    expect(
      skillAuthoring(capsWith(["global"], ["global"], undefined), "global"),
    ).toEqual({
      canWrite: true,
      canImport: true,
      canInspect: false,
      canAuthor: true,
    });
  });

  it("opens only write when only create advertises the selected scope", () => {
    expect(skillAuthoring(capsWith(["global"], [], undefined), "global")).toEqual(
      {
        canWrite: true,
        canImport: false,
        canInspect: false,
        canAuthor: true,
      },
    );
  });

  it("opens only import when only import advertises the selected scope", () => {
    expect(skillAuthoring(capsWith([], ["global"], undefined), "global")).toEqual(
      {
        canWrite: false,
        canImport: true,
        canInspect: false,
        canAuthor: true,
      },
    );
  });

  it("opens neither when neither action advertises the selected scope", () => {
    expect(skillAuthoring(capsWith([], [], undefined), "global")).toEqual({
      canWrite: false,
      canImport: false,
      canInspect: false,
      canAuthor: false,
    });
  });

  // The load-bearing case: the tab lists and mutates at the selected scope, so
  // a provider that advertises just "project" must NOT get a button while the
  // user is viewing Global. `length > 0` would wrongly pass this.
  it("treats a project-only verb as closed when viewing global", () => {
    expect(
      skillAuthoring(capsWith(["project"], ["project"], undefined), "global"),
    ).toEqual({
      canWrite: false,
      canImport: false,
      canInspect: false,
      canAuthor: false,
    });
  });

  it("opens project verbs when viewing project", () => {
    expect(
      skillAuthoring(capsWith(["project"], ["project"], undefined), "project"),
    ).toEqual({
      canWrite: true,
      canImport: true,
      canInspect: false,
      canAuthor: true,
    });
  });

  it("treats a missing inspect key as the old-host single-shot path", () => {
    const authoring = skillAuthoring(
      capsWith(["global"], ["global"], undefined),
      "global",
    );
    expect(authoring.canInspect).toBe(false);
    expect("inspect" in capsWith(["global"], ["global"], undefined).actionScopes)
      .toBe(false);
  });

  it("treats an empty inspect array as no inspect for this scope", () => {
    expect(
      skillAuthoring(capsWith(["global"], ["global"], []), "global"),
    ).toMatchObject({ canInspect: false });
  });

  it("opens inspect when the selected scope is advertised", () => {
    expect(
      skillAuthoring(capsWith(["global"], ["global"], ["global"]), "global"),
    ).toEqual({
      canWrite: true,
      canImport: true,
      canInspect: true,
      canAuthor: true,
    });
  });

  it("keeps inspect closed when only the other scope is advertised", () => {
    expect(
      skillAuthoring(capsWith(["global"], ["global"], ["project"]), "global")
        .canInspect,
    ).toBe(false);
    expect(
      skillAuthoring(capsWith(["project"], ["project"], ["global"]), "project")
        .canInspect,
    ).toBe(false);
  });
});

describe("skillProviderScopeVisible", () => {
  it("is always visible at global scope, even before a provider root is known", () => {
    expect(
      skillProviderScopeVisible({
        effectiveScope: "global",
        providerRoot: null,
      }),
    ).toBe(true);
    expect(
      skillProviderScopeVisible({
        effectiveScope: "global",
        providerRoot: "/Users/dev/.codex/skills",
      }),
    ).toBe(true);
  });

  it("hides provider-only at project scope until a provider root is known", () => {
    expect(
      skillProviderScopeVisible({
        effectiveScope: "project",
        providerRoot: null,
      }),
    ).toBe(false);
    expect(
      skillProviderScopeVisible({
        effectiveScope: "project",
        providerRoot: "/Users/dev/app/.codex/skills",
      }),
    ).toBe(true);
  });
});

describe("previewSkillMd", () => {
  it("mirrors the host's formatSkillMd byte-for-byte for a filled-in skill", () => {
    // Matches `traycer-host/.../skills-helpers.ts:formatSkillMd` exactly:
    // `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`.
    const result = previewSkillMd({
      name: "review-pr",
      description: "Reviews a pull request for bugs.",
      body: "## Steps\n\n1. Read the diff.",
    });
    expect(result).toBe(
      '---\nname: review-pr\ndescription: "Reviews a pull request for bugs."\n---\n\n## Steps\n\n1. Read the diff.\n',
    );
  });

  it("falls back to my-skill when the name is empty", () => {
    const result = previewSkillMd({
      name: "",
      description: "x",
      body: "body",
    });
    expect(result).toContain("\nname: my-skill\n");
  });

  it("falls back to a heading built from the name when the body is empty", () => {
    const result = previewSkillMd({
      name: "review-pr",
      description: "x",
      body: "   ",
    });
    expect(result).toBe(
      '---\nname: review-pr\ndescription: "x"\n---\n\n# review-pr\n\n',
    );
  });

  it("JSON-quotes a description containing a quote and a newline", () => {
    const result = previewSkillMd({
      name: "review-pr",
      description: 'Say "hi" to them\nand smile',
      body: "body",
    });
    expect(result).toContain(
      'description: "Say \\"hi\\" to them\\nand smile"\n',
    );
  });
});

describe("skillNameError", () => {
  it("treats an empty name as not-yet-an-error", () => {
    expect(skillNameError("")).toBeNull();
    expect(skillNameError("   ")).toBeNull();
  });

  it("accepts a valid lowercase-and-hyphen slug", () => {
    expect(skillNameError("review-pr")).toBeNull();
  });

  it.each([
    ["uppercase letters", "Review-Pr"],
    ["spaces", "review pr"],
    ["a leading hyphen", "-review-pr"],
    ["a trailing hyphen", "review-pr-"],
    ["an underscore", "review_pr"],
  ])("rejects %s", (_label, name) => {
    expect(skillNameError(name)).not.toBeNull();
  });
});

describe("skillSubmitBlocker", () => {
  it("blocks import with an empty source", () => {
    expect(
      skillSubmitBlocker({
        step: "import",
        name: "",
        description: "",
        source: "   ",
        selectedNames: [],
      }),
    ).toBe("Enter a source to import from.");
  });

  it("is ready for import once a source is present, regardless of write fields", () => {
    expect(
      skillSubmitBlocker({
        step: "import",
        name: "",
        description: "",
        source: "https://github.com/org/skill.git",
        selectedNames: [],
      }),
    ).toBeNull();
  });

  it("blocks picker with no selected names", () => {
    expect(
      skillSubmitBlocker({
        step: "picker",
        name: "",
        description: "",
        source: "owner/repo",
        selectedNames: [],
      }),
    ).toBe("Select at least one skill to install.");
  });

  it("is ready for picker once at least one name is selected", () => {
    expect(
      skillSubmitBlocker({
        step: "picker",
        name: "",
        description: "",
        source: "owner/repo",
        selectedNames: ["show-me"],
      }),
    ).toBeNull();
  });

  it("blocks write with no name", () => {
    expect(
      skillSubmitBlocker({
        step: "write",
        name: "",
        description: "x",
        source: "",
        selectedNames: [],
      }),
    ).toBe("Give the skill a name.");
  });

  it("blocks write with an invalid name", () => {
    expect(
      skillSubmitBlocker({
        step: "write",
        name: "Not Valid",
        description: "x",
        source: "",
        selectedNames: [],
      }),
    ).toBe(skillNameError("Not Valid"));
  });

  it("blocks write with no description", () => {
    expect(
      skillSubmitBlocker({
        step: "write",
        name: "review-pr",
        description: "   ",
        source: "",
        selectedNames: [],
      }),
    ).toBe(
      "Add a description — the agent reads it to decide when to use this skill.",
    );
  });

  it("is ready for write once name and description are both present", () => {
    expect(
      skillSubmitBlocker({
        step: "write",
        name: "review-pr",
        description: "Reviews a PR.",
        source: "",
        selectedNames: [],
      }),
    ).toBeNull();
  });
});

describe("skillNamesFromSourceFlags", () => {
  it("returns nothing when the source has no skill flags", () => {
    expect(skillNamesFromSourceFlags("npx skills add owner/repo")).toEqual([]);
    expect(skillNamesFromSourceFlags("https://github.com/org/skills.git")).toEqual(
      [],
    );
  });

  it("parses -s, --skill, and --skill=name forms", () => {
    expect(
      skillNamesFromSourceFlags(
        "npx skills add owner/repo -s show-me --skill design-control-loop --skill=improve-claude-md",
      ),
    ).toEqual(["show-me", "design-control-loop", "improve-claude-md"]);
  });

  it("dedupes repeated flags and does not leak lastIndex across calls", () => {
    const source = "npx skills add owner/repo -s show-me -s show-me";
    expect(skillNamesFromSourceFlags(source)).toEqual(["show-me"]);
    expect(skillNamesFromSourceFlags(source)).toEqual(["show-me"]);
  });
});

describe("preselectSkillNames", () => {
  const candidates: readonly ProviderSkillInspectCandidate[] = [
    {
      name: "show-me",
      description: "Diagrams",
      relPath: "show-me/SKILL.md",
      installed: true,
    },
    {
      name: "design-control-loop",
      description: null,
      relPath: "design-control-loop/SKILL.md",
      installed: false,
    },
    {
      name: "narrow-react-prop-types",
      description: null,
      relPath: "narrow-react-prop-types/SKILL.md",
      installed: false,
    },
  ];

  it("returns nothing when no flags were parsed", () => {
    expect(preselectSkillNames(candidates, [])).toEqual([]);
  });

  it("intersects in candidate order, dropping flags that are not in the list", () => {
    expect(
      preselectSkillNames(candidates, [
        "missing",
        "narrow-react-prop-types",
        "show-me",
      ]),
    ).toEqual(["show-me", "narrow-react-prop-types"]);
  });
});

describe("isSkillSourceShaMismatch", () => {
  it("rejects non-Error values", () => {
    expect(isSkillSourceShaMismatch("sha mismatch")).toBe(false);
    expect(isSkillSourceShaMismatch({ message: "sha mismatch" })).toBe(false);
  });

  it.each([
    ["SHA mismatch on token"],
    ["source sha moved since inspect"],
    ["commit hash changed"],
    ["the SHAs differ"],
  ])("recognizes %s", (message) => {
    expect(isSkillSourceShaMismatch(new Error(message))).toBe(true);
  });

  it("does not treat an unrelated sha mention as a mismatch", () => {
    expect(isSkillSourceShaMismatch(new Error("could not resolve sha"))).toBe(
      false,
    );
    expect(isSkillSourceShaMismatch(new Error("import failed"))).toBe(false);
  });
});

describe("composerErrorMessage", () => {
  it("uses a non-empty Error message", () => {
    expect(composerErrorMessage(new Error("  clone failed  "))).toBe(
      "clone failed",
    );
  });

  it("falls back when the value is not a useful Error", () => {
    expect(composerErrorMessage(new Error("   "))).toBe(
      "Couldn't add this skill.",
    );
    expect(composerErrorMessage("clone failed")).toBe(
      "Couldn't add this skill.",
    );
  });
});

describe("skillDestination", () => {
  it("points shared writes at the fixed cross-provider root", () => {
    expect(
      skillDestination({
        providerScoped: false,
        providerLabel: "Codex",
        providerRoot: "/Users/dev/.codex/skills",
      }),
    ).toEqual({ display: "~/.agents/skills", exact: true });
  });

  it("points provider-scoped writes at a known provider root", () => {
    expect(
      skillDestination({
        providerScoped: true,
        providerLabel: "Codex",
        providerRoot: "/Users/dev/.codex/skills",
      }),
    ).toEqual({ display: "/Users/dev/.codex/skills", exact: true });
  });

  it("falls back to honest prose when the provider root is not yet known", () => {
    expect(
      skillDestination({
        providerScoped: true,
        providerLabel: "Codex",
        providerRoot: null,
      }),
    ).toEqual({
      display: "Codex's own skills folder",
      exact: false,
    });
  });
});

describe("skillFilePath", () => {
  it("appends name and SKILL.md onto an exact destination", () => {
    const destination = skillDestination({
      providerScoped: false,
      providerLabel: "Codex",
      providerRoot: null,
    });
    expect(skillFilePath({ destination, name: "review-pr" })).toBe(
      "~/.agents/skills/review-pr/SKILL.md",
    );
  });

  it("returns the destination unchanged when the name is still empty", () => {
    const destination = skillDestination({
      providerScoped: false,
      providerLabel: "Codex",
      providerRoot: null,
    });
    expect(skillFilePath({ destination, name: "   " })).toBe(
      "~/.agents/skills",
    );
  });

  it("returns the prose unchanged, rather than appending a name to it, when the destination is inexact", () => {
    const destination = skillDestination({
      providerScoped: true,
      providerLabel: "Codex",
      providerRoot: null,
    });
    expect(skillFilePath({ destination, name: "review-pr" })).toBe(
      "Codex's own skills folder",
    );
  });
});

describe("providerRootFromSkills", () => {
  const base: ProviderSkill = {
    name: "find-skills",
    description: null,
    path: "/Users/dev/.agents/skills/find-skills",
    source: "shared",
  };

  it("takes the parent directory of the first provider-sourced row", () => {
    const skills: ProviderSkill[] = [
      { ...base, source: "shared", path: "/Users/dev/.agents/skills/find" },
      {
        ...base,
        source: "provider",
        path: "/Users/dev/.codex/skills/deploy",
      },
    ];
    expect(providerRootFromSkills(skills)).toBe("/Users/dev/.codex/skills");
  });

  it("ignores shared, plugin, and managed rows even when they come first", () => {
    const skills: ProviderSkill[] = [
      { ...base, source: "shared", path: "/Users/dev/.agents/skills/a" },
      { ...base, source: "plugin", path: "/Users/dev/.plugin/skills/b" },
      { ...base, source: "managed", path: "/Users/dev/.traycer/skills/c" },
      { ...base, source: "provider", path: "/Users/dev/.codex/skills/d" },
    ];
    expect(providerRootFromSkills(skills)).toBe("/Users/dev/.codex/skills");
  });

  it("returns null when there is no provider-sourced row", () => {
    const skills: ProviderSkill[] = [
      { ...base, source: "shared" },
      { ...base, source: "managed" },
    ];
    expect(providerRootFromSkills(skills)).toBeNull();
  });

  it("honours a Windows-style backslash path", () => {
    const skills: ProviderSkill[] = [
      {
        ...base,
        source: "provider",
        path: "C:\\Users\\dev\\.codex\\skills\\deploy",
      },
    ];
    expect(providerRootFromSkills(skills)).toBe(
      "C:\\Users\\dev\\.codex\\skills",
    );
  });
});
