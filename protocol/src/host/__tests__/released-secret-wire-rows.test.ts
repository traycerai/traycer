import { describe, expect, it } from "vitest";
import { guiHarnessSandboxCredentialModeSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  environmentMoveAcceptRequestSchema,
  environmentMovePlanResponseSchema,
  environmentMovePlanResponseSchemaV11,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  environmentReviewHeldApplyRequestSchema,
  environmentSecretsCreateRequestSchemaV11,
  environmentSecretsListResponseSchemaV12,
} from "@traycer/protocol/host/environment-schemas";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_CREATE_FIELDS,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";
import {
  CLI_V152_MOVE_KEY_CHOICES,
  CLI_V152_MOVE_PLAN_ROW_GROUPS,
  CLI_V152_MOVE_PLAN_ROW_GROUPS_V11,
  CLI_V152_SANDBOX_CREDENTIAL_MODES,
  CLI_V152_SECRETS_LIST_RESPONSE_V12,
} from "./__fixtures__/cli-v1-5-2-retired-wire";

/**
 * A released desktop is the parser here. `cli-v1.5.2` and `cli-v1.5.3` call
 * `environment.secrets.list` from the getting-started checklist as soon as a
 * host advertises the method, so a row this tree builds has to satisfy their
 * schema on a landing surface, not only on the Secrets page.
 */

function rowOfThisTree(variables: readonly string[]): unknown {
  return environmentSecretsListResponseSchemaV12.parse({
    secrets: [
      {
        secretId: "sec-1",
        name: "SERVICE_TOKEN",
        kind: "api_key",
        protocol: "https",
        destinations: ["api.example.com"],
        ...RETIRED_SECRET_ROW_FIELDS,
        currentVersionId: "ver-1",
        revoked: false,
        updatedAt: 1,
        variables: [...variables],
        providerVariables: [...RETIRED_PROVIDER_VARIABLES],
      },
    ],
  });
}

describe("a released desktop parses what this tree sends", () => {
  it("parses an empty secrets list", () => {
    const answer = environmentSecretsListResponseSchemaV12.parse({
      secrets: [],
    });

    expect(
      CLI_V152_SECRETS_LIST_RESPONSE_V12.parse(answer).secrets,
    ).toStrictEqual([]);
  });

  it("parses one brokered secret, retired fields and all", () => {
    const released = CLI_V152_SECRETS_LIST_RESPONSE_V12.parse(
      rowOfThisTree(["SERVICE_TOKEN"]),
    );

    expect(released.secrets[0]?.mode).toBe("brokered");
    expect(released.secrets[0]?.state).toBe("live");
    expect(released.secrets[0]?.providerVariables).toStrictEqual([]);
    expect(released.secrets[0]?.variables).toStrictEqual(["SERVICE_TOKEN"]);
  });

  // The regression itself: this is the row the cut shipped, and it is what a
  // released desktop could not read. Each missing key is named, so a later
  // removal of one from the schema fails here rather than on a merge run.
  it.each(["mode", "state", "providerVariables"])(
    "a row built without %s is rejected by the released parser",
    (key) => {
      const answer = rowOfThisTree(["SERVICE_TOKEN"]) as {
        secrets: Record<string, unknown>[];
      };
      const [row] = answer.secrets;
      if (row === undefined) throw new Error("the fixture builds one row");
      delete row[key];

      const parsed = CLI_V152_SECRETS_LIST_RESPONSE_V12.safeParse(answer);

      expect(parsed.success).toBe(false);
    },
  );

  it("keeps every row group a released plan names", () => {
    const groups = Object.keys(
      environmentMovePlanResponseSchema.parse({
        planHash: "h",
        planRevision: 0,
        hostVersion: "1.6.0",
        disclosureVersion: 1,
        rows: {
          moves: [],
          staysOnThisComputer: [],
          alreadyInPersonal: [],
          differsMasked: [],
          looksLikeAKey: [],
        },
      }).rows,
    );

    expect(groups.sort()).toStrictEqual(
      [...CLI_V152_MOVE_PLAN_ROW_GROUPS].sort(),
    );
  });

  // `sameNameInPersonal` is the other group the cut took, added at `@1.1`.
  // The released schema gives it `.default([])`, so this case states both
  // halves of that: a plan built WITHOUT the key still parses, and the parsed
  // rows carry it anyway, so a released desktop reading `@1.1` or `@1.2`
  // finds every group it declares.
  it("answers the @1.1 plan's own row groups, filling the one it no longer builds", () => {
    const parsed = environmentMovePlanResponseSchemaV11.parse({
      planHash: "h",
      planRevision: 0,
      hostVersion: "1.6.0",
      disclosureVersion: 1,
      rows: {
        moves: [],
        staysOnThisComputer: [],
        alreadyInPersonal: [],
        differsMasked: [],
        looksLikeAKey: [],
      },
    });

    expect(Object.keys(parsed.rows).sort()).toStrictEqual(
      [...CLI_V152_MOVE_PLAN_ROW_GROUPS_V11].sort(),
    );
    expect(parsed.rows.sameNameInPersonal).toStrictEqual([]);
  });
});

describe("this tree reads what a released desktop may still send", () => {
  it.each(CLI_V152_MOVE_KEY_CHOICES)(
    "reads the retired move choice %s rather than refusing the frame",
    (choice) => {
      const parsed = environmentMoveAcceptRequestSchema.parse({
        planHash: "h",
        keyChoices: [{ key: "item:variable:SERVICE_TOKEN", choice }],
      });

      expect(parsed.keyChoices[0]?.choice).toBe(choice);
    },
  );

  it("reads the retired held `secret` choice with its whole binding", () => {
    const parsed = environmentReviewHeldApplyRequestSchema.parse({
      heldId: "held-1",
      choice: "secret",
      kind: "api_key",
      protocol: "https",
      hosts: ["api.example.com"],
      port: null,
      portOverride: false,
      swapSites: ["header"],
      plaintextConsent: null,
    });

    expect(parsed.choice).toBe("secret");
  });

  it.each(["variable", "stays"] as const)(
    "reads the retired held choice %s",
    (choice) => {
      const parsed = environmentReviewHeldApplyRequestSchema.parse({
        heldId: "held-1",
        choice,
      });

      expect(parsed.choice).toBe(choice);
    },
  );

  it.each(CLI_V152_SANDBOX_CREDENTIAL_MODES)(
    "reads the catalog's %s credential mode",
    (mode) => {
      expect(guiHarnessSandboxCredentialModeSchema.parse(mode)).toBe(mode);
    },
  );

  it("sends a create request this tree's own schema accepts", () => {
    const parsed = environmentSecretsCreateRequestSchemaV11.parse({
      environmentId: null,
      name: "SERVICE_TOKEN",
      kind: "api_key",
      protocol: "https",
      hosts: ["api.example.com"],
      port: null,
      identity: null,
      database: null,
      policy: null,
      tlsPolicy: null,
      pinnedHostKeys: null,
      connectorId: null,
      confirmedAddresses: null,
      value: "the-value",
      ...RETIRED_SECRET_CREATE_FIELDS,
      portOverride: false,
      swapSites: ["header"],
      variables: [],
      sandboxesByDefault: true,
      plaintextConsent: null,
    });

    expect(parsed.mode).toBe("brokered");
    expect(parsed.exportPolicy).toBeNull();
  });
});
