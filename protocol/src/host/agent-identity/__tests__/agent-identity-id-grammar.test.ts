import { describe, expect, it } from "vitest";
import { agentIdentityIdSchema } from "@traycer/protocol/host/agent-identity/schemas";
import { agentIdentityFilesDeleteRequestSchema } from "@traycer/protocol/host/agent-identity/unary-schemas";
import {
  chatRunSettingsSchema,
  chatRunSettingsStrictSchema,
} from "@traycer/protocol/persistence/epic/foundation";

/**
 * The identity-id grammar, `^[A-Za-z0-9][A-Za-z0-9_]{0,35}$` - the rule
 * `packages/common` mints identities under, restated here because the protocol
 * cannot import it. Checked at the wire so a malformed id is a parse refusal,
 * never a string a host resolver joins into a room id, blob key or directory.
 */

const VALID = [
  "01J9Z8Q4X7M2N5P6R3S0T1V2W4", // a ULID
  "identity_1",
  "a",
  "A".repeat(36),
];

const INVALID = [
  "",
  "identity-1", // dash
  "../etc",
  "a/b",
  "a.b",
  "_leading",
  "A".repeat(37),
  "has space",
];

describe("agentIdentityIdSchema", () => {
  it.each(VALID)("accepts %s", (id) => {
    expect(agentIdentityIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(INVALID)("refuses %j", (id) => {
    expect(agentIdentityIdSchema.safeParse(id).success).toBe(false);
  });

  it("guards every family request - a traversal id never reaches a resolver", () => {
    expect(
      agentIdentityFilesDeleteRequestSchema.safeParse({
        identityId: "../../etc",
        path: "SOUL.md",
      }).success,
    ).toBe(false);
  });
});

describe("the chat's identityId", () => {
  const TUPLE = {
    harnessId: "claude",
    model: "claude-sonnet-4",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  } as const;

  it("takes the same grammar on the persisted and the strict tuple, null allowed", () => {
    for (const schema of [chatRunSettingsSchema, chatRunSettingsStrictSchema]) {
      expect(
        schema.safeParse({ ...TUPLE, identityId: "identity_1" }).success,
      ).toBe(true);
      expect(schema.safeParse({ ...TUPLE, identityId: null }).success).toBe(
        true,
      );
      expect(
        schema.safeParse({ ...TUPLE, identityId: "identity-1" }).success,
      ).toBe(false);
    }
  });
});
