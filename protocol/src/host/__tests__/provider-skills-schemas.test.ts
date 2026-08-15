/**
 * Schema unit tests for the skills-settings redesign additions:
 * inspect / edit / update mutate actions, inspect result, ProviderSkill
 * origin/conflict, live capability skew-gate keys, and the frozen v7.0
 * copies that must not grow those keys.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  nativeListResultSchema,
  nativeListResultSchemaV70,
  nativeMutationResultSchema,
  nativeMutationSchema,
  providerSkillInspectCandidateSchema,
  providerSkillSchema,
  providerSkillSchemaV70,
  providerSkillsCapabilitiesSchema,
  providerSkillsCapabilitiesSchemaV70,
  providersSkillsInspectResultSchema,
} from "@traycer/protocol/host/provider-native-schemas";

type SkillsScope = "global" | "project";

function skillsMutation(mutation: unknown, scope: SkillsScope): unknown {
  return {
    kind: "skills",
    scope,
    workspaceRoot: scope === "project" ? "/repo" : null,
    mutation,
  };
}

function omitKey(value: Record<string, unknown>, key: string): unknown {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

const BASE_SKILL_ROW = {
  name: "frontend-design",
  description: "UI skill",
  path: "/Users/me/.agents/skills/frontend-design",
  source: "shared" as const,
};

const BASE_ACTION_SCOPES = {
  list: ["global"] as const,
  add: ["global"] as const,
  create: ["global"] as const,
  import: ["global"] as const,
  remove: ["global"] as const,
};

const INSPECT_CANDIDATE = {
  name: "frontend-design",
  description: "UI skill",
  relPath: "frontend-design/SKILL.md",
  installed: false,
};

const INSPECT_RESULT = {
  ok: true as const,
  kind: "skillsInspect" as const,
  token: "inspect-token-1",
  commitSha: "abc123def456",
  candidates: [INSPECT_CANDIDATE],
};

describe("providersSkillsMutateActionSchema via nativeMutationSchema", () => {
  describe("inspect", () => {
    it("parses global and project inspect envelopes", () => {
      const globalParsed = nativeMutationSchema.parse(
        skillsMutation(
          {
            action: "inspect",
            source: "https://github.com/org/skills",
            scope: "global",
          },
          "global",
        ),
      );
      expect(globalParsed.kind).toBe("skills");
      if (globalParsed.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(globalParsed.mutation).toEqual({
        action: "inspect",
        source: "https://github.com/org/skills",
        scope: "global",
      });

      const projectParsed = nativeMutationSchema.parse(
        skillsMutation(
          { action: "inspect", source: "owner/repo", scope: "project" },
          "project",
        ),
      );
      expect(projectParsed.kind).toBe("skills");
      if (projectParsed.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(projectParsed.mutation).toEqual({
        action: "inspect",
        source: "owner/repo",
        scope: "project",
      });
    });

    it("rejects missing source, empty source, and missing/invalid scope", () => {
      const valid = {
        action: "inspect",
        source: "owner/repo",
        scope: "global",
      };
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(omitKey(valid, "source"), "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, source: "" }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(omitKey(valid, "scope"), "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, scope: "cwd" }, "global"),
        ).success,
      ).toBe(false);
    });

    it("rejects an inspect scope that differs from the envelope scope", () => {
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(
            { action: "inspect", source: "owner/repo", scope: "project" },
            "global",
          ),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(
            { action: "inspect", source: "owner/repo", scope: "global" },
            "project",
          ),
        ).success,
      ).toBe(false);
    });
  });

  describe("edit", () => {
    const VALID_EXPECTED_HASH = "a".repeat(64);

    it("parses a complete edit envelope", () => {
      const parsed = nativeMutationSchema.parse(
        skillsMutation(
          {
            action: "edit",
            path: "/Users/me/.agents/skills/frontend-design/SKILL.md",
            expectedHash: VALID_EXPECTED_HASH,
            name: "frontend-design",
            description: "UI skill",
            body: "# frontend-design\n",
          },
          "global",
        ),
      );
      expect(parsed.kind).toBe("skills");
      if (parsed.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(parsed.mutation).toEqual({
        action: "edit",
        path: "/Users/me/.agents/skills/frontend-design/SKILL.md",
        expectedHash: VALID_EXPECTED_HASH,
        name: "frontend-design",
        description: "UI skill",
        body: "# frontend-design\n",
      });
    });

    it("rejects missing path, name, description, body, or expectedHash", () => {
      const valid = {
        action: "edit",
        path: "/skills/frontend-design/SKILL.md",
        expectedHash: VALID_EXPECTED_HASH,
        name: "frontend-design",
        description: "UI skill",
        body: "# body\n",
      };
      for (const key of [
        "path",
        "name",
        "description",
        "body",
        "expectedHash",
      ] as const) {
        expect(
          nativeMutationSchema.safeParse(
            skillsMutation(omitKey(valid, key), "global"),
          ).success,
        ).toBe(false);
      }
    });

    it("rejects empty path or name", () => {
      const valid = {
        action: "edit",
        path: "/skills/frontend-design/SKILL.md",
        expectedHash: VALID_EXPECTED_HASH,
        name: "frontend-design",
        description: "UI skill",
        body: "# body\n",
      };
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, path: "" }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, name: "" }, "global"),
        ).success,
      ).toBe(false);
    });

    it("rejects a malformed expectedHash", () => {
      const valid = {
        action: "edit",
        path: "/skills/frontend-design/SKILL.md",
        expectedHash: VALID_EXPECTED_HASH,
        name: "frontend-design",
        description: "UI skill",
        body: "# body\n",
      };
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, expectedHash: "" }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, expectedHash: "A".repeat(64) }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, expectedHash: "a".repeat(63) }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, expectedHash: "a".repeat(65) }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(
            { ...valid, expectedHash: `${"a".repeat(63)}g` },
            "global",
          ),
        ).success,
      ).toBe(false);
    });
  });

  describe("update", () => {
    it("parses with and without confirm", () => {
      const base = {
        action: "update",
        name: "frontend-design",
        path: "/Users/me/.agents/skills/frontend-design",
      };
      const withoutConfirm = nativeMutationSchema.parse(
        skillsMutation(base, "global"),
      );
      expect(withoutConfirm.kind).toBe("skills");
      if (withoutConfirm.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(withoutConfirm.mutation).toEqual(base);

      const withConfirm = nativeMutationSchema.parse(
        skillsMutation({ ...base, confirm: true }, "project"),
      );
      expect(withConfirm.kind).toBe("skills");
      if (withConfirm.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(withConfirm.mutation).toEqual({ ...base, confirm: true });

      const withConfirmFalse = nativeMutationSchema.parse(
        skillsMutation({ ...base, confirm: false }, "global"),
      );
      expect(withConfirmFalse.kind).toBe("skills");
      if (withConfirmFalse.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(withConfirmFalse.mutation).toEqual({ ...base, confirm: false });
    });

    it("rejects missing name or path", () => {
      const valid = {
        action: "update",
        name: "frontend-design",
        path: "/skills/frontend-design",
      };
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(omitKey(valid, "name"), "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation(omitKey(valid, "path"), "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, name: "" }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, path: "" }, "global"),
        ).success,
      ).toBe(false);
    });
  });

  describe("import", () => {
    it("still parses the legacy {source, providerScoped} payload", () => {
      const parsed = nativeMutationSchema.parse(
        skillsMutation(
          {
            action: "import",
            source: "https://github.com/org/skills",
            providerScoped: false,
          },
          "global",
        ),
      );
      expect(parsed.kind).toBe("skills");
      if (parsed.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(parsed.mutation).toEqual({
        action: "import",
        source: "https://github.com/org/skills",
        providerScoped: false,
      });
    });

    it("parses with optional token and names", () => {
      const parsed = nativeMutationSchema.parse(
        skillsMutation(
          {
            action: "import",
            source: "https://github.com/org/skills",
            providerScoped: true,
            token: "inspect-token-1",
            names: ["frontend-design", "better-colors"],
          },
          "project",
        ),
      );
      expect(parsed.kind).toBe("skills");
      if (parsed.kind !== "skills") {
        throw new Error("expected skills mutation");
      }
      expect(parsed.mutation).toEqual({
        action: "import",
        source: "https://github.com/org/skills",
        providerScoped: true,
        token: "inspect-token-1",
        names: ["frontend-design", "better-colors"],
      });
    });

    it("rejects empty token or empty name entries when those fields are sent", () => {
      const valid = {
        action: "import",
        source: "https://github.com/org/skills",
        providerScoped: false,
        token: "inspect-token-1",
        names: ["frontend-design"],
      };
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, token: "" }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...valid, names: [""] }, "global"),
        ).success,
      ).toBe(false);
    });

    it("rejects token-only and names-only import payloads", () => {
      const base = {
        action: "import",
        source: "https://github.com/org/skills",
        providerScoped: false,
      };
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...base, token: "inspect-token-1" }, "global"),
        ).success,
      ).toBe(false);
      expect(
        nativeMutationSchema.safeParse(
          skillsMutation({ ...base, names: ["frontend-design"] }, "global"),
        ).success,
      ).toBe(false);
    });
  });

  it("legacy add / create / remove still parse", () => {
    expect(
      nativeMutationSchema.safeParse(
        skillsMutation(
          {
            action: "add",
            sourcePath: "/tmp/my-skill",
            providerScoped: false,
          },
          "global",
        ),
      ).success,
    ).toBe(true);
    expect(
      nativeMutationSchema.safeParse(
        skillsMutation(
          {
            action: "create",
            name: "my-skill",
            description: "desc",
            body: "# body\n",
            providerScoped: true,
          },
          "project",
        ),
      ).success,
    ).toBe(true);
    expect(
      nativeMutationSchema.safeParse(
        skillsMutation(
          {
            action: "remove",
            name: "my-skill",
            path: "/tmp/my-skill",
          },
          "global",
        ),
      ).success,
    ).toBe(true);
  });
});

describe("providersSkillsInspectResultSchema", () => {
  it("parses a complete inspect result", () => {
    const parsed = providersSkillsInspectResultSchema.parse({
      token: "inspect-token-1",
      commitSha: "abc123def456",
      candidates: [
        INSPECT_CANDIDATE,
        {
          name: "better-colors",
          description: null,
          relPath: "better-colors/SKILL.md",
          installed: true,
        },
      ],
    });
    expect(parsed.token).toBe("inspect-token-1");
    expect(parsed.commitSha).toBe("abc123def456");
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[1]?.description).toBeNull();
    expect(parsed.candidates[1]?.installed).toBe(true);
  });

  it("rejects missing token, commitSha, or candidates", () => {
    const valid = {
      token: "inspect-token-1",
      commitSha: "abc123def456",
      candidates: [INSPECT_CANDIDATE],
    };
    expect(
      providersSkillsInspectResultSchema.safeParse(omitKey(valid, "token"))
        .success,
    ).toBe(false);
    expect(
      providersSkillsInspectResultSchema.safeParse(omitKey(valid, "commitSha"))
        .success,
    ).toBe(false);
    expect(
      providersSkillsInspectResultSchema.safeParse(omitKey(valid, "candidates"))
        .success,
    ).toBe(false);
  });

  it("rejects empty token or commitSha", () => {
    const valid = {
      token: "inspect-token-1",
      commitSha: "abc123def456",
      candidates: [INSPECT_CANDIDATE],
    };
    expect(
      providersSkillsInspectResultSchema.safeParse({ ...valid, token: "" })
        .success,
    ).toBe(false);
    expect(
      providersSkillsInspectResultSchema.safeParse({ ...valid, commitSha: "" })
        .success,
    ).toBe(false);
  });

  it("requires candidate installed as a boolean", () => {
    expect(
      providerSkillInspectCandidateSchema.safeParse(INSPECT_CANDIDATE).success,
    ).toBe(true);
    expect(
      providerSkillInspectCandidateSchema.safeParse(
        omitKey(INSPECT_CANDIDATE, "installed"),
      ).success,
    ).toBe(false);
    expect(
      providerSkillInspectCandidateSchema.safeParse({
        ...INSPECT_CANDIDATE,
        installed: "yes",
      }).success,
    ).toBe(false);
  });
});

describe("nativeMutationResultSchema skills success kinds", () => {
  it("accepts kind: skills", () => {
    const parsed = nativeMutationResultSchema.parse({
      ok: true,
      kind: "skills",
      skills: [BASE_SKILL_ROW],
    });
    expect(parsed).toEqual({
      ok: true,
      kind: "skills",
      skills: [BASE_SKILL_ROW],
    });
  });

  it("accepts kind: skillsInspect", () => {
    const parsed = nativeMutationResultSchema.parse(INSPECT_RESULT);
    expect(parsed).toEqual(INSPECT_RESULT);
  });

  it("rejects a skillsInspect result missing token, commitSha, or candidates", () => {
    expect(
      nativeMutationResultSchema.safeParse(omitKey(INSPECT_RESULT, "token"))
        .success,
    ).toBe(false);
    expect(
      nativeMutationResultSchema.safeParse(omitKey(INSPECT_RESULT, "commitSha"))
        .success,
    ).toBe(false);
    expect(
      nativeMutationResultSchema.safeParse(
        omitKey(INSPECT_RESULT, "candidates"),
      ).success,
    ).toBe(false);
  });
});

describe("providerSkillSchema origin and conflict", () => {
  it("parses the legacy four-field row", () => {
    expect(providerSkillSchema.parse(BASE_SKILL_ROW)).toEqual(BASE_SKILL_ROW);
  });

  it("accepts origin as a string or null, and conflict true", () => {
    expect(
      providerSkillSchema.parse({
        ...BASE_SKILL_ROW,
        origin: "Imported from github.com/org/skills",
        conflict: true,
      }),
    ).toEqual({
      ...BASE_SKILL_ROW,
      origin: "Imported from github.com/org/skills",
      conflict: true,
    });
    expect(
      providerSkillSchema.parse({
        ...BASE_SKILL_ROW,
        origin: null,
      }),
    ).toEqual({
      ...BASE_SKILL_ROW,
      origin: null,
    });
  });

  it("live native list result keeps origin and conflict on skill rows", () => {
    const parsed = nativeListResultSchema.parse({
      ok: true,
      kind: "skills",
      skills: [
        {
          ...BASE_SKILL_ROW,
          origin: "Imported from github.com/org/skills",
          conflict: true,
        },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      kind: "skills",
      skills: [
        {
          ...BASE_SKILL_ROW,
          origin: "Imported from github.com/org/skills",
          conflict: true,
        },
      ],
    });
  });
});

describe("providerSkillsCapabilitiesSchema actionScopes skew gate", () => {
  it("parses a descriptor without inspect / edit / update keys", () => {
    const parsed = providerSkillsCapabilitiesSchema.parse({
      actionScopes: BASE_ACTION_SCOPES,
    });
    expect(parsed.actionScopes).toEqual(BASE_ACTION_SCOPES);
    expect(parsed.actionScopes).not.toHaveProperty("inspect");
    expect(parsed.actionScopes).not.toHaveProperty("edit");
    expect(parsed.actionScopes).not.toHaveProperty("update");
  });

  it("accepts inspect / edit / update when present", () => {
    const parsed = providerSkillsCapabilitiesSchema.parse({
      actionScopes: {
        ...BASE_ACTION_SCOPES,
        inspect: ["global", "project"],
        edit: ["global"],
        update: ["project"],
      },
    });
    expect(parsed.actionScopes.inspect).toEqual(["global", "project"]);
    expect(parsed.actionScopes.edit).toEqual(["global"]);
    expect(parsed.actionScopes.update).toEqual(["project"]);
  });
});

describe("v7.0 frozen skills shapes do not grow the new keys", () => {
  it("V70 skills capabilities JSON schema rejects inspect / edit / update keys", () => {
    const json = z.toJSONSchema(providerSkillsCapabilitiesSchemaV70, {
      unrepresentable: "any",
    });
    expect(json).toMatchObject({ additionalProperties: false });
    const actionScopes = json.properties?.actionScopes;
    expect(actionScopes).toMatchObject({ additionalProperties: false });
    if (
      actionScopes === undefined ||
      typeof actionScopes !== "object" ||
      !("properties" in actionScopes)
    ) {
      throw new Error("expected actionScopes object schema");
    }
    expect(actionScopes.properties).not.toHaveProperty("inspect");
    expect(actionScopes.properties).not.toHaveProperty("edit");
    expect(actionScopes.properties).not.toHaveProperty("update");
    expect(Object.keys(actionScopes.properties ?? {}).sort()).toEqual(
      ["add", "create", "import", "list", "remove"].sort(),
    );
  });

  it("V70 skills capabilities parse without the new keys and drop them if sent", () => {
    const withoutNew = providerSkillsCapabilitiesSchemaV70.parse({
      actionScopes: BASE_ACTION_SCOPES,
    });
    expect(withoutNew.actionScopes).toEqual(BASE_ACTION_SCOPES);
    expect(withoutNew.actionScopes).not.toHaveProperty("inspect");

    const withNew = providerSkillsCapabilitiesSchemaV70.parse({
      actionScopes: {
        ...BASE_ACTION_SCOPES,
        inspect: ["global"],
        edit: ["global"],
        update: ["global"],
      },
    });
    expect(withNew.actionScopes).toEqual(BASE_ACTION_SCOPES);
    expect(withNew.actionScopes).not.toHaveProperty("inspect");
    expect(withNew.actionScopes).not.toHaveProperty("edit");
    expect(withNew.actionScopes).not.toHaveProperty("update");
  });

  it("V70 skill row JSON schema rejects origin and conflict", () => {
    const json = z.toJSONSchema(providerSkillSchemaV70, {
      unrepresentable: "any",
    });
    expect(json).toMatchObject({ additionalProperties: false });
    expect(json.properties).not.toHaveProperty("origin");
    expect(json.properties).not.toHaveProperty("conflict");
    expect(Object.keys(json.properties ?? {}).sort()).toEqual(
      ["description", "name", "path", "source"].sort(),
    );
  });

  it("V70 skill row parse drops origin and conflict", () => {
    expect(providerSkillSchemaV70.parse(BASE_SKILL_ROW)).toEqual(
      BASE_SKILL_ROW,
    );
    expect(
      providerSkillSchemaV70.parse({
        ...BASE_SKILL_ROW,
        origin: "Imported from github.com/org/skills",
        conflict: true,
      }),
    ).toEqual(BASE_SKILL_ROW);
  });

  it("V70 native list result does not keep origin or conflict on skill rows", () => {
    const parsed = nativeListResultSchemaV70.parse({
      ok: true,
      kind: "skills",
      skills: [
        {
          ...BASE_SKILL_ROW,
          origin: "Imported from github.com/org/skills",
          conflict: true,
        },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      kind: "skills",
      skills: [BASE_SKILL_ROW],
    });
  });
});
