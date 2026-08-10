import type {
  ProviderNativeScope,
  ProviderSkill,
  ProviderSkillsCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import { describe, expect, it } from "vitest";
import {
  previewSkillMd,
  providerRootFromSkills,
  skillAuthoring,
  skillComposerTabs,
  skillDestination,
  skillFilePath,
  skillNameError,
  skillSubmitBlocker,
  type SkillAuthoring,
} from "@/components/settings/panels/provider-skill-composer-model";

function capsWith(
  create: readonly ProviderNativeScope[],
  importScopes: readonly ProviderNativeScope[],
): ProviderSkillsCapabilities {
  return {
    actionScopes: {
      list: ["global"],
      add: [],
      create: [...create],
      import: [...importScopes],
      remove: [],
    },
  };
}

describe("skillAuthoring", () => {
  it("opens both paths when both actions advertise the selected scope", () => {
    expect(skillAuthoring(capsWith(["global"], ["global"]), "global")).toEqual({
      canWrite: true,
      canImport: true,
      canAuthor: true,
    });
  });

  it("opens only write when only create advertises the selected scope", () => {
    expect(skillAuthoring(capsWith(["global"], []), "global")).toEqual({
      canWrite: true,
      canImport: false,
      canAuthor: true,
    });
  });

  it("opens only import when only import advertises the selected scope", () => {
    expect(skillAuthoring(capsWith([], ["global"]), "global")).toEqual({
      canWrite: false,
      canImport: true,
      canAuthor: true,
    });
  });

  it("opens neither when neither action advertises the selected scope", () => {
    expect(skillAuthoring(capsWith([], []), "global")).toEqual({
      canWrite: false,
      canImport: false,
      canAuthor: false,
    });
  });

  // The load-bearing case: the tab lists and mutates at the selected scope, so
  // a provider that advertises just "project" must NOT get a button while the
  // user is viewing Global. `length > 0` would wrongly pass this.
  it("treats a project-only verb as closed when viewing global", () => {
    expect(
      skillAuthoring(capsWith(["project"], ["project"]), "global"),
    ).toEqual({
      canWrite: false,
      canImport: false,
      canAuthor: false,
    });
  });

  it("opens project verbs when viewing project", () => {
    expect(
      skillAuthoring(capsWith(["project"], ["project"]), "project"),
    ).toEqual({
      canWrite: true,
      canImport: true,
      canAuthor: true,
    });
  });
});

describe("skillComposerTabs", () => {
  const both: SkillAuthoring = {
    canWrite: true,
    canImport: true,
    canAuthor: true,
  };
  const writeOnly: SkillAuthoring = {
    canWrite: true,
    canImport: false,
    canAuthor: true,
  };
  const importOnly: SkillAuthoring = {
    canWrite: false,
    canImport: true,
    canAuthor: true,
  };
  const neither: SkillAuthoring = {
    canWrite: false,
    canImport: false,
    canAuthor: false,
  };

  it("returns both tabs when both paths are open", () => {
    expect(skillComposerTabs(both)).toEqual(["write", "import"]);
  });

  it("returns no tabs when only write is open", () => {
    // A one-tab strip would look like a control that selects nothing.
    expect(skillComposerTabs(writeOnly)).toEqual([]);
  });

  it("returns no tabs when only import is open", () => {
    expect(skillComposerTabs(importOnly)).toEqual([]);
  });

  it("returns no tabs when neither is open", () => {
    expect(skillComposerTabs(neither)).toEqual([]);
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
        tab: "import",
        name: "",
        description: "",
        source: "   ",
      }),
    ).toBe("Enter a git URL or a folder path to import from.");
  });

  it("is ready for import once a source is present, regardless of write fields", () => {
    expect(
      skillSubmitBlocker({
        tab: "import",
        name: "",
        description: "",
        source: "https://github.com/org/skill.git",
      }),
    ).toBeNull();
  });

  it("blocks write with no name", () => {
    expect(
      skillSubmitBlocker({
        tab: "write",
        name: "",
        description: "x",
        source: "",
      }),
    ).toBe("Give the skill a name.");
  });

  it("blocks write with an invalid name", () => {
    expect(
      skillSubmitBlocker({
        tab: "write",
        name: "Not Valid",
        description: "x",
        source: "",
      }),
    ).toBe(skillNameError("Not Valid"));
  });

  it("blocks write with no description", () => {
    expect(
      skillSubmitBlocker({
        tab: "write",
        name: "review-pr",
        description: "   ",
        source: "",
      }),
    ).toBe(
      "Add a description — the agent reads it to decide when to use this skill.",
    );
  });

  it("is ready for write once name and description are both present", () => {
    expect(
      skillSubmitBlocker({
        tab: "write",
        name: "review-pr",
        description: "Reviews a PR.",
        source: "",
      }),
    ).toBeNull();
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
