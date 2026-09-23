/**
 * `identitySkillMutate` — the adapter from the composer's
 * `ProvidersSkillsMutateAction` vocabulary onto an identity's
 * `agentIdentity.skills.inspect` / `.import` RPCs.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AgentIdentitySkillsImportRequest,
  AgentIdentitySkillsImportResponse,
  AgentIdentitySkillsInspectRequest,
  AgentIdentitySkillsInspectResponse,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { ProviderSkillInspectCandidate } from "@traycer/protocol/host/provider-native-schemas";
import { identitySkillMutate } from "@/lib/identities/skill-install-target";

const DESIGN_LOOP: ProviderSkillInspectCandidate = {
  name: "design-control-loop",
  description: "Iterate on a design.",
  relPath: "design-control-loop/SKILL.md",
  installed: false,
};

function buildMutate(overrides: {
  inspect?: (
    request: AgentIdentitySkillsInspectRequest,
  ) => Promise<AgentIdentitySkillsInspectResponse>;
  importSkills?: (
    request: AgentIdentitySkillsImportRequest,
  ) => Promise<AgentIdentitySkillsImportResponse>;
  onImported?: (paths: readonly string[]) => void;
}) {
  const inspect =
    overrides.inspect ??
    vi.fn<
      (
        request: AgentIdentitySkillsInspectRequest,
      ) => Promise<AgentIdentitySkillsInspectResponse>
    >();
  const importSkills =
    overrides.importSkills ??
    vi.fn<
      (
        request: AgentIdentitySkillsImportRequest,
      ) => Promise<AgentIdentitySkillsImportResponse>
    >();
  const onImported =
    overrides.onImported ?? vi.fn<(paths: readonly string[]) => void>();
  const onMutate = identitySkillMutate({
    identityId: "identity-1",
    inspect,
    importSkills,
    onImported,
  });
  return { onMutate, inspect, importSkills, onImported };
}

describe("identitySkillMutate", () => {
  it("routes an inspect action through agentIdentity.skills.inspect with the identity id and source", async () => {
    const inspect =
      vi.fn<
        (
          request: AgentIdentitySkillsInspectRequest,
        ) => Promise<AgentIdentitySkillsInspectResponse>
      >();
    inspect.mockResolvedValue({
      kind: "inspected",
      token: "tok-1",
      commitSha: "a".repeat(40),
      candidates: [DESIGN_LOOP],
    });
    const { onMutate } = buildMutate({ inspect });

    const result = await onMutate({
      action: "inspect",
      source: "owner/repo",
      scope: "global",
    });

    expect(inspect).toHaveBeenCalledExactlyOnceWith({
      identityId: "identity-1",
      source: "owner/repo",
    });
    expect(result).toEqual({
      kind: "inspect",
      token: "tok-1",
      candidates: [DESIGN_LOOP],
    });
  });

  it("throws the skill-specific copy for a pathExists inspect refusal", async () => {
    const inspect =
      vi.fn<
        (
          request: AgentIdentitySkillsInspectRequest,
        ) => Promise<AgentIdentitySkillsInspectResponse>
      >();
    inspect.mockResolvedValue({
      kind: "refused",
      reason: "pathExists",
      detail: "already there",
    });
    const { onMutate } = buildMutate({ inspect });

    await expect(
      onMutate({ action: "inspect", source: "owner/repo", scope: "global" }),
    ).rejects.toThrow(
      "A skill with that name is already in this identity. Remove it first to install this one.",
    );
  });

  it("throws the generic identity refusal copy for a non-skill-specific reason", async () => {
    const inspect =
      vi.fn<
        (
          request: AgentIdentitySkillsInspectRequest,
        ) => Promise<AgentIdentitySkillsInspectResponse>
      >();
    inspect.mockResolvedValue({
      kind: "refused",
      reason: "identityNotFound",
      detail: "gone",
    });
    const { onMutate } = buildMutate({ inspect });

    await expect(
      onMutate({ action: "inspect", source: "owner/repo", scope: "global" }),
    ).rejects.toThrow("This identity no longer exists on the host.");
  });

  it("routes an import action with token and names through agentIdentity.skills.import, calls onImported, and returns an empty skills list", async () => {
    const importSkills =
      vi.fn<
        (
          request: AgentIdentitySkillsImportRequest,
        ) => Promise<AgentIdentitySkillsImportResponse>
      >();
    importSkills.mockResolvedValue({
      kind: "imported",
      installed: [DESIGN_LOOP],
      paths: ["skills/design-control-loop/SKILL.md"],
    });
    const onImported = vi.fn<(paths: readonly string[]) => void>();
    const { onMutate } = buildMutate({ importSkills, onImported });

    const result = await onMutate({
      action: "import",
      source: "owner/repo",
      providerScoped: false,
      token: "tok-1",
      names: ["design-control-loop"],
    });

    expect(importSkills).toHaveBeenCalledExactlyOnceWith({
      identityId: "identity-1",
      token: "tok-1",
      names: ["design-control-loop"],
    });
    expect(onImported).toHaveBeenCalledExactlyOnceWith([
      "skills/design-control-loop/SKILL.md",
    ]);
    expect(result).toEqual({ kind: "skills", skills: [] });
  });

  it("throws the skill-specific copy for a pathExists import refusal without calling onImported", async () => {
    const importSkills =
      vi.fn<
        (
          request: AgentIdentitySkillsImportRequest,
        ) => Promise<AgentIdentitySkillsImportResponse>
      >();
    importSkills.mockResolvedValue({
      kind: "refused",
      reason: "pathExists",
      detail: "already there",
    });
    const onImported = vi.fn<(paths: readonly string[]) => void>();
    const { onMutate } = buildMutate({ importSkills, onImported });

    await expect(
      onMutate({
        action: "import",
        source: "owner/repo",
        providerScoped: false,
        token: "tok-1",
        names: ["design-control-loop"],
      }),
    ).rejects.toThrow(
      "A skill with that name is already in this identity. Remove it first to install this one.",
    );
    expect(onImported).not.toHaveBeenCalled();
  });

  it("throws the generic identity refusal copy for a non-skill-specific import reason", async () => {
    const importSkills =
      vi.fn<
        (
          request: AgentIdentitySkillsImportRequest,
        ) => Promise<AgentIdentitySkillsImportResponse>
      >();
    importSkills.mockResolvedValue({
      kind: "refused",
      reason: "identityNotFound",
      detail: "gone",
    });
    const { onMutate } = buildMutate({ importSkills });

    await expect(
      onMutate({
        action: "import",
        source: "owner/repo",
        providerScoped: false,
        token: "tok-1",
        names: ["design-control-loop"],
      }),
    ).rejects.toThrow("This identity no longer exists on the host.");
  });

  it("throws without calling inspect or importSkills for an import missing token or names", async () => {
    const { onMutate, inspect, importSkills } = buildMutate({});

    await expect(
      onMutate({
        action: "import",
        source: "owner/repo",
        providerScoped: false,
      }),
    ).rejects.toThrow("Identities install skills from a source only.");
    expect(inspect).not.toHaveBeenCalled();
    expect(importSkills).not.toHaveBeenCalled();
  });

  it("throws without calling either RPC for a create action", async () => {
    const { onMutate, inspect, importSkills } = buildMutate({});

    await expect(
      onMutate({
        action: "create",
        name: "review-pr",
        description: "Reviews a pull request.",
        body: "# review-pr\n",
        providerScoped: false,
      }),
    ).rejects.toThrow("Identities install skills from a source only.");
    expect(inspect).not.toHaveBeenCalled();
    expect(importSkills).not.toHaveBeenCalled();
  });

  it("throws without calling either RPC for a remove action", async () => {
    const { onMutate, inspect, importSkills } = buildMutate({});

    await expect(
      onMutate({
        action: "remove",
        name: "review-pr",
        path: "review-pr/SKILL.md",
      }),
    ).rejects.toThrow("Identities install skills from a source only.");
    expect(inspect).not.toHaveBeenCalled();
    expect(importSkills).not.toHaveBeenCalled();
  });
});
