/**
 * An identity as a destination for the skill composer.
 *
 * The composer speaks the provider installer's action vocabulary
 * (`inspect`, then `import` with the inspect token and the ticked names).
 * `agentIdentity.skills.inspect` / `.import` are that same two-step pointed at
 * an identity's `skills/` root, so an identity target is an adapter from those
 * two actions onto the two RPCs; every other action (create, edit, remove,
 * update) is a provider-root operation the identity installer does not offer.
 *
 * A refusal becomes a thrown error carrying user copy, which is how the
 * composer already renders a failed provider mutation inline.
 */
import type {
  AgentIdentitySkillsImportRequest,
  AgentIdentitySkillsImportResponse,
  AgentIdentitySkillsInspectRequest,
  AgentIdentitySkillsInspectResponse,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import type { ProvidersSkillsMutateAction } from "@traycer/protocol/host/provider-native-schemas";
import type { SkillsMutateData } from "@/hooks/providers/native-response-map";
import { identityRefusalCopy } from "./refusal-copy";

export interface IdentitySkillTarget {
  readonly identityId: string;
  readonly title: string;
  readonly onMutate: (
    mutation: ProvidersSkillsMutateAction,
  ) => Promise<SkillsMutateData>;
}

/** Copy for the refusals whose generic sentence reads wrong for a skill. */
function skillRefusalCopy(reason: string): string {
  switch (reason) {
    case "pathExists":
      return "A skill with that name is already in this identity. Remove it first to install this one.";
    case "tooLarge":
      return "A file in this skill is too large for an identity.";
    case "refusedContent":
      return "The host refused a file in this skill.";
    default:
      return identityRefusalCopy(reason);
  }
}

export function identitySkillMutate(args: {
  readonly identityId: string;
  readonly inspect: (
    request: AgentIdentitySkillsInspectRequest,
  ) => Promise<AgentIdentitySkillsInspectResponse>;
  readonly importSkills: (
    request: AgentIdentitySkillsImportRequest,
  ) => Promise<AgentIdentitySkillsImportResponse>;
  /** The paths an import wrote, for the caller to open one. */
  readonly onImported: (paths: readonly string[]) => void;
}): (mutation: ProvidersSkillsMutateAction) => Promise<SkillsMutateData> {
  return async (mutation) => {
    if (mutation.action === "inspect") {
      const response = await args.inspect({
        identityId: args.identityId,
        source: mutation.source,
      });
      if (response.kind === "refused") {
        throw new Error(skillRefusalCopy(response.reason));
      }
      return {
        kind: "inspect",
        token: response.token,
        candidates: response.candidates,
      };
    }
    if (
      mutation.action === "import" &&
      mutation.token !== undefined &&
      mutation.names !== undefined &&
      mutation.names.length > 0
    ) {
      const response = await args.importSkills({
        identityId: args.identityId,
        token: mutation.token,
        names: mutation.names,
      });
      if (response.kind === "refused") {
        throw new Error(skillRefusalCopy(response.reason));
      }
      args.onImported(response.paths);
      // The identity's rows ride its index lane; there is no provider list to
      // hand back.
      return { kind: "skills", skills: [] };
    }
    throw new Error("Identities install skills from a source only.");
  };
}
