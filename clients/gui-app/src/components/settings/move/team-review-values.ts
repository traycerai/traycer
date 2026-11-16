import { z } from "zod";
import {
  heldFactsOf,
  maskedHeldText,
  type HeldFacts,
} from "@traycer/protocol/host/environment/held-facts";
import {
  fallbackPolicySchema,
  type FallbackPolicy,
} from "@traycer/protocol/host/fallback-policy";
import {
  providerProfileAccentColorSchema,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { authnMcpServerItemValueSchema } from "@traycer-clients/shared/environment/authn-environment-schemas";
import type {
  ReviewHeldEntry,
  ReviewHeldProjectionInput,
} from "@traycer-clients/shared/environment/environment-review";
import {
  configurationPackValueSchema,
  configurationProfileValueSchema,
  configurationShellValueSchema,
  configurationTextValueSchema,
} from "@/hooks/environment/team/configuration-item-values";

interface ReviewToolGroup {
  readonly id: string;
  readonly harness: string;
  readonly tools: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
  }[];
}

export type TeamReviewValue =
  | { readonly kind: "unreadable" }
  | { readonly kind: "facts"; readonly facts: HeldFacts }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "profile";
      readonly name: string;
      readonly color: ProviderProfileAccentColor | null;
      readonly harnessId: string;
      readonly accountIdentity: string | null;
      readonly enabled: boolean;
      readonly needsLink: boolean;
    }
  | {
      readonly kind: "pack";
      readonly pinnedVersion: string | null;
      readonly autoDownload: boolean;
    }
  | {
      readonly kind: "fallback";
      readonly policy: FallbackPolicy;
      readonly tierLabels: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "mcp";
      readonly reference: string | null;
      readonly command: string | null;
      readonly groups: readonly ReviewToolGroup[];
      readonly offFor: readonly string[];
    };

export interface TeamReviewEntry {
  readonly entry: ReviewHeldEntry;
  /** Null is a held removal, distinct from a value that cannot be shown. */
  readonly proposed: TeamReviewValue | null;
  /** Null means that no live item exists at this address. */
  readonly current: TeamReviewValue | null;
}

const textValueSchema = z.object({ text: z.string() });
const fallbackValueSchema = z.object({ document: fallbackPolicySchema });
const legacyMcpValueSchema = z.strictObject({
  definition: z.strictObject({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
  }),
  toolToggles: authnMcpServerItemValueSchema.shape.toolToggles,
});

const UNREADABLE: TeamReviewValue = { kind: "unreadable" };

function maskedText(text: string): string {
  return maskedHeldText(text) ?? "";
}

/** Keys used for row identity never depend on labels that may mask alike. */
function maskedFallback(policy: FallbackPolicy): TeamReviewValue {
  const ids = new Map<string, string>();
  const tierLabels: Record<string, string> = {};
  const tierGroups = policy.tierGroups.map((group, index) => {
    const id = `review-tier-${String(index)}`;
    ids.set(group.id, id);
    tierLabels[id] = maskedText(group.id);
    return {
      id,
      candidates: group.candidates.map((candidate) => ({
        ...candidate,
        modelFamily: maskedText(candidate.modelFamily),
        reasoningEffort:
          candidate.reasoningEffort === null
            ? null
            : maskedText(candidate.reasoningEffort),
      })),
    };
  });
  return {
    kind: "fallback",
    tierLabels,
    policy: {
      ...policy,
      tierGroups,
      defaultTierGroupId:
        policy.defaultTierGroupId === null
          ? null
          : (ids.get(policy.defaultTierGroupId) ?? null),
    },
  };
}

function toolGroups(
  toggles: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
): readonly ReviewToolGroup[] {
  return Object.entries(toggles).map(([harness, tools], groupIndex) => ({
    id: `review-harness-${String(groupIndex)}`,
    harness: maskedText(harness),
    tools: Object.entries(tools).map(([name, enabled], toolIndex) => ({
      id: `review-tool-${String(toolIndex)}`,
      name: maskedText(name),
      enabled,
    })),
  }));
}

function mcpValue(key: string, value: unknown): TeamReviewValue {
  const modern = authnMcpServerItemValueSchema.strict().safeParse(value);
  if (modern.success) {
    return {
      kind: "mcp",
      reference: maskedText(modern.data.mcpServerId),
      command: null,
      groups: toolGroups(modern.data.toolToggles),
      offFor: (modern.data.offFor ?? []).map(maskedText),
    };
  }
  const legacy = legacyMcpValueSchema.safeParse(value);
  if (!legacy.success) return UNREADABLE;
  return {
    kind: "mcp",
    reference: null,
    command: heldFactsOf({ kind: "mcp_server", key, value }).command,
    groups: toolGroups(legacy.data.toolToggles),
    offFor: [],
  };
}

function reviewValue(
  kind: string,
  key: string,
  value: unknown,
): TeamReviewValue {
  switch (kind) {
    case "managed_profile": {
      const parsed = configurationProfileValueSchema.safeParse(value);
      if (!parsed.success) return UNREADABLE;
      const profile = parsed.data;
      return {
        kind: "profile",
        name: maskedText(profile.name),
        color: providerProfileAccentColorSchema
          .nullable()
          .catch(null)
          .parse(profile.color),
        harnessId: maskedText(profile.harnessId),
        accountIdentity:
          profile.accountIdentity === null
            ? null
            : maskedText(profile.accountIdentity),
        enabled: profile.enabled,
        needsLink: profile.needsLink,
      };
    }
    case "pack_policy": {
      const parsed = configurationPackValueSchema.safeParse(value);
      if (!parsed.success) return UNREADABLE;
      return {
        kind: "pack",
        pinnedVersion:
          parsed.data.pinnedVersion === null
            ? null
            : maskedText(parsed.data.pinnedVersion),
        autoDownload: parsed.data.autoDownload,
      };
    }
    case "fallback_policy": {
      const parsed = fallbackValueSchema.safeParse(value);
      return parsed.success ? maskedFallback(parsed.data.document) : UNREADABLE;
    }
    case "agent_definition": {
      const parsed = textValueSchema.safeParse(value);
      return parsed.success
        ? { kind: "text", text: maskedText(parsed.data.text) }
        : UNREADABLE;
    }
    case "mcp_server":
      return mcpValue(key, value);
    case "shell":
    case "variable":
    case "env_override":
    case "setup_script": {
      const parsed =
        kind === "shell"
          ? configurationShellValueSchema.safeParse(value)
          : kind === "setup_script"
            ? textValueSchema.safeParse(value)
            : configurationTextValueSchema.safeParse(value);
      if (!parsed.success) return UNREADABLE;
      const facts = heldFactsOf({ kind, key, value });
      return {
        kind: "facts",
        facts: {
          ...facts,
          harness: facts.harness === null ? null : maskedText(facts.harness),
        },
      };
    }
    default:
      return UNREADABLE;
  }
}

/** No unmasked proposed or live value escapes the operation-view read. */
export function projectTeamReview(
  input: ReviewHeldProjectionInput,
): TeamReviewEntry {
  const { entry } = input;
  return {
    entry: {
      ...entry,
      key: maskedText(entry.key),
      harness: entry.harness === null ? null : maskedText(entry.harness),
    },
    proposed:
      entry.op === "delete"
        ? null
        : reviewValue(entry.kind, entry.key, input.proposed),
    current:
      input.current === null
        ? null
        : reviewValue(entry.kind, entry.key, input.current.value),
  };
}
