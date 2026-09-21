import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toJsonSchemaFingerprint } from "@traycer/protocol/framework/json-schema-fingerprint";
import {
  authenticatedUserResponseRecordV100,
  exchangeTokenResponseRecordV100,
  legacyAuthenticatedUserResponseRecordV100,
  listAllMcpServersResponseRecordV100,
  organizationRecordV100,
  providerLoginResponseRecordV100,
  userRecordV100,
} from "@traycer/protocol/auth/registry";

/**
 * Nothing else in this repo guards the auth records: an in-place edit of
 * `userSchema` (or any other retained-major-1 auth schema) would pass every
 * existing check and break every released client that validates
 * `GET /api/v3/user` against the frozen four-value provider enum.
 *
 * A FAILURE HERE MEANS: record major 1 is frozen. The fix is a new major
 * with a downgrade bridge (see `auth-record-bridges.test.ts`), never an
 * edit to the major-1 contract itself.
 *
 * The table is written explicitly rather than derived by filtering the
 * registry, so the suite cannot pass vacuously by deriving an empty
 * population from a broken filter.
 */
const FROZEN_MAJOR_1_CONTRACTS = [
  { name: "user", contract: userRecordV100 },
  {
    name: "authenticated-user-response",
    contract: authenticatedUserResponseRecordV100,
  },
  {
    name: "legacy-authenticated-user-response",
    contract: legacyAuthenticatedUserResponseRecordV100,
  },
  { name: "organization", contract: organizationRecordV100 },
  {
    name: "provider-login-response",
    contract: providerLoginResponseRecordV100,
  },
  {
    name: "exchange-token-response",
    contract: exchangeTokenResponseRecordV100,
  },
  {
    name: "list-all-mcp-servers-response",
    contract: listAllMcpServersResponseRecordV100,
  },
] as const;

/**
 * Every occurrence of a `providerType` property anywhere in `schema`'s raw
 * JSON Schema, walked structurally rather than at a hand-picked path - so
 * the check does not silently stop working when a contract's nesting
 * changes shape.
 */
function findProviderTypeEnumValues(
  schema: z.ZodType,
): readonly (readonly unknown[])[] {
  const raw = z.toJSONSchema(schema, { unrepresentable: "any" });
  const found: unknown[][] = [];

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const providerType = record["providerType"];
    if (typeof providerType === "object" && providerType !== null) {
      const enumValues = (providerType as Record<string, unknown>)["enum"];
      if (Array.isArray(enumValues)) found.push(enumValues);
    }
    for (const value of Object.values(record)) walk(value);
  }

  walk(raw);
  return found;
}

describe("auth records - major 1 is frozen", () => {
  it("covers a non-empty, explicitly-major-1.0 population", () => {
    expect(FROZEN_MAJOR_1_CONTRACTS.length).toBeGreaterThan(0);
    for (const { contract } of FROZEN_MAJOR_1_CONTRACTS) {
      expect(contract.schemaVersion).toEqual({ major: 1, minor: 0 });
    }
  });

  for (const { name, contract } of FROZEN_MAJOR_1_CONTRACTS) {
    describe(name, () => {
      it("has a providerType value set of exactly the four pre-Apple values", () => {
        const enums = findProviderTypeEnumValues(contract.schema);
        expect(enums.length).toBeGreaterThan(0);
        for (const values of enums) {
          expect([...values].sort()).toEqual([
            "EMAIL",
            "GITHUB",
            "GITLAB",
            "GOOGLE",
          ]);
        }
      });

      it("never mentions APPLE anywhere in its fingerprint", () => {
        const fingerprint = toJsonSchemaFingerprint(contract.schema, name);
        expect(JSON.stringify(fingerprint)).not.toContain("APPLE");
      });
    });
  }

  // The backstop: a committed, whole-fingerprint comparison per contract,
  // generated once and pasted in by running this file and confirming the
  // captured shape is the expected one (four provider values, no `APPLE`) -
  // not derived from the contract at run time, or this would assert
  // nothing. One `it()` per contract rather than a loop: inline snapshots
  // are keyed by call site, so a loop would overwrite the same snapshot on
  // every iteration instead of pinning each contract's own shape.
  describe("committed fingerprints", () => {
    it("user 1.0", () => {
      expect(toJsonSchemaFingerprint(userRecordV100.schema, "user"))
        .toMatchInlineSnapshot(`
        {
          "properties": {
            "activatedAt": {
              "anyOf": [
                {},
                {
                  "type": "null",
                },
              ],
            },
            "avatarUrl": {
              "anyOf": [
                {
                  "type": "string",
                },
                {
                  "type": "null",
                },
              ],
            },
            "createdAt": {},
            "email": {
              "anyOf": [
                {
                  "type": "string",
                },
                {
                  "type": "null",
                },
              ],
            },
            "id": {
              "type": "string",
            },
            "isLearningEnabled": {
              "type": "boolean",
            },
            "lastSeenAt": {
              "anyOf": [
                {},
                {
                  "type": "null",
                },
              ],
            },
            "name": {
              "anyOf": [
                {
                  "type": "string",
                },
                {
                  "type": "null",
                },
              ],
            },
            "privacyMode": {
              "type": "boolean",
            },
            "providerHandle": {
              "type": "string",
            },
            "providerId": {
              "type": "string",
            },
            "providerType": {
              "enum": [
                "GITHUB",
                "GOOGLE",
                "GITLAB",
                "EMAIL",
              ],
              "type": "string",
            },
            "updatedAt": {},
          },
          "required": [
            "id",
            "name",
            "providerId",
            "providerHandle",
            "providerType",
            "email",
            "avatarUrl",
            "activatedAt",
            "createdAt",
            "updatedAt",
            "lastSeenAt",
            "privacyMode",
            "isLearningEnabled",
          ],
          "type": "object",
        }
      `);
    });

    it("authenticated-user-response 1.0", () => {
      expect(
        toJsonSchemaFingerprint(
          authenticatedUserResponseRecordV100.schema,
          "authenticated-user-response",
        ),
      ).toMatchInlineSnapshot(`
        {
          "properties": {
            "hostId": {
              "anyOf": [
                {
                  "type": "string",
                },
                {
                  "type": "null",
                },
              ],
            },
            "payAsYouGoUsage": {
              "additionalProperties": false,
              "properties": {
                "allowPayAsYouGo": {
                  "type": "boolean",
                },
              },
              "required": [
                "allowPayAsYouGo",
              ],
              "type": "object",
            },
            "teamSubscriptions": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "bundleSummary": {
                    "additionalProperties": false,
                    "properties": {
                      "bundleConsumed": {
                        "type": "number",
                      },
                      "bundleRemaining": {
                        "type": "number",
                      },
                      "bundleTotal": {
                        "type": "number",
                      },
                    },
                    "required": [
                      "bundleTotal",
                      "bundleConsumed",
                      "bundleRemaining",
                    ],
                    "type": "object",
                  },
                  "createdAt": {},
                  "credit": {
                    "additionalProperties": false,
                    "properties": {
                      "bonusCredits": {
                        "type": "number",
                      },
                      "consumedFromBonus": {
                        "type": "number",
                      },
                      "consumedFromPlan": {
                        "type": "number",
                      },
                      "customerId": {
                        "type": "string",
                      },
                      "id": {
                        "type": "string",
                      },
                      "lastResetAt": {},
                      "orgId": {
                        "type": "string",
                      },
                      "userId": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "id",
                      "userId",
                      "customerId",
                      "bonusCredits",
                      "consumedFromPlan",
                      "consumedFromBonus",
                      "lastResetAt",
                      "orgId",
                    ],
                    "type": "object",
                  },
                  "customerId": {
                    "type": "string",
                  },
                  "hasActiveBundle": {
                    "type": "boolean",
                  },
                  "hasPaymentMethod": {
                    "anyOf": [
                      {
                        "type": "boolean",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "id": {
                    "type": "string",
                  },
                  "isInTrial": {
                    "type": "boolean",
                  },
                  "orgID": {
                    "anyOf": [
                      {
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "rechargeRateSeconds": {
                    "type": "number",
                  },
                  "subscriptionExpiry": {
                    "anyOf": [
                      {},
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "subscriptionStatus": {
                    "enum": [
                      "PENDING",
                      "FREE",
                      "PRO_LEGACY",
                      "PRO",
                      "PRO_PLUS",
                      "LITE",
                      "LITE_V2",
                      "PRO_V2",
                      "PRO_PLUS_V2",
                      "LITE_V3",
                      "PRO_V3",
                      "ULTRA_1X_V3",
                      "ULTRA_2X_V3",
                      "ULTRA_3X_V3",
                      "ULTRA_4X_V3",
                      "ULTRA_5X_V3",
                      "BYOA_V3",
                    ],
                    "type": "string",
                  },
                  "team": {
                    "additionalProperties": false,
                    "properties": {
                      "avatarUrl": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "createdAt": {},
                      "id": {
                        "type": "string",
                      },
                      "privacyMode": {
                        "type": "boolean",
                      },
                      "slug": {
                        "type": "string",
                      },
                      "updatedAt": {},
                    },
                    "required": [
                      "id",
                      "slug",
                      "avatarUrl",
                      "privacyMode",
                      "createdAt",
                      "updatedAt",
                    ],
                    "type": "object",
                  },
                  "teamID": {
                    "anyOf": [
                      {
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "totalPlanCredits": {
                    "type": "number",
                  },
                  "trialEndsAt": {
                    "anyOf": [
                      {},
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "updatedAt": {},
                  "userID": {
                    "anyOf": [
                      {
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                },
                "required": [
                  "id",
                  "userID",
                  "orgID",
                  "teamID",
                  "customerId",
                  "createdAt",
                  "updatedAt",
                  "subscriptionExpiry",
                  "trialEndsAt",
                  "subscriptionStatus",
                  "hasPaymentMethod",
                  "team",
                  "isInTrial",
                  "bundleSummary",
                  "totalPlanCredits",
                  "rechargeRateSeconds",
                  "hasActiveBundle",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "user": {
              "additionalProperties": false,
              "properties": {
                "activatedAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "avatarUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "createdAt": {},
                "email": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "id": {
                  "type": "string",
                },
                "isLearningEnabled": {
                  "type": "boolean",
                },
                "lastSeenAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "name": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "privacyMode": {
                  "type": "boolean",
                },
                "providerHandle": {
                  "type": "string",
                },
                "providerId": {
                  "type": "string",
                },
                "providerType": {
                  "enum": [
                    "GITHUB",
                    "GOOGLE",
                    "GITLAB",
                    "EMAIL",
                  ],
                  "type": "string",
                },
                "updatedAt": {},
              },
              "required": [
                "id",
                "name",
                "providerId",
                "providerHandle",
                "providerType",
                "email",
                "avatarUrl",
                "activatedAt",
                "createdAt",
                "updatedAt",
                "lastSeenAt",
                "privacyMode",
                "isLearningEnabled",
              ],
              "type": "object",
            },
            "userSubscription": {
              "additionalProperties": false,
              "properties": {
                "bundleSummary": {
                  "additionalProperties": false,
                  "properties": {
                    "bundleConsumed": {
                      "type": "number",
                    },
                    "bundleRemaining": {
                      "type": "number",
                    },
                    "bundleTotal": {
                      "type": "number",
                    },
                  },
                  "required": [
                    "bundleTotal",
                    "bundleConsumed",
                    "bundleRemaining",
                  ],
                  "type": "object",
                },
                "createdAt": {},
                "credit": {
                  "additionalProperties": false,
                  "properties": {
                    "bonusCredits": {
                      "type": "number",
                    },
                    "consumedFromBonus": {
                      "type": "number",
                    },
                    "consumedFromPlan": {
                      "type": "number",
                    },
                    "customerId": {
                      "type": "string",
                    },
                    "id": {
                      "type": "string",
                    },
                    "lastResetAt": {},
                    "userId": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "id",
                    "userId",
                    "customerId",
                    "bonusCredits",
                    "consumedFromPlan",
                    "consumedFromBonus",
                    "lastResetAt",
                  ],
                  "type": "object",
                },
                "customerId": {
                  "type": "string",
                },
                "hasActiveBundle": {
                  "type": "boolean",
                },
                "hasPaymentMethod": {
                  "anyOf": [
                    {
                      "type": "boolean",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "id": {
                  "type": "string",
                },
                "isInTrial": {
                  "type": "boolean",
                },
                "orgID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "rechargeRateSeconds": {
                  "type": "number",
                },
                "subscriptionExpiry": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "subscriptionStatus": {
                  "enum": [
                    "PENDING",
                    "FREE",
                    "PRO_LEGACY",
                    "PRO",
                    "PRO_PLUS",
                    "LITE",
                    "LITE_V2",
                    "PRO_V2",
                    "PRO_PLUS_V2",
                    "LITE_V3",
                    "PRO_V3",
                    "ULTRA_1X_V3",
                    "ULTRA_2X_V3",
                    "ULTRA_3X_V3",
                    "ULTRA_4X_V3",
                    "ULTRA_5X_V3",
                    "BYOA_V3",
                  ],
                  "type": "string",
                },
                "teamID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "totalPlanCredits": {
                  "type": "number",
                },
                "trialEndsAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "updatedAt": {},
                "userID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
              },
              "required": [
                "id",
                "userID",
                "orgID",
                "teamID",
                "customerId",
                "createdAt",
                "updatedAt",
                "subscriptionExpiry",
                "trialEndsAt",
                "subscriptionStatus",
                "hasPaymentMethod",
                "isInTrial",
                "rechargeRateSeconds",
              ],
              "type": "object",
            },
          },
          "required": [
            "user",
            "userSubscription",
            "payAsYouGoUsage",
            "teamSubscriptions",
          ],
          "type": "object",
        }
      `);
    });

    it("legacy-authenticated-user-response 1.0", () => {
      expect(
        toJsonSchemaFingerprint(
          legacyAuthenticatedUserResponseRecordV100.schema,
          "legacy-authenticated-user-response",
        ),
      ).toMatchInlineSnapshot(`
        {
          "properties": {
            "organizationSubscription": {
              "additionalProperties": false,
              "properties": {
                "bundleSummary": {
                  "additionalProperties": false,
                  "properties": {
                    "bundleConsumed": {
                      "type": "number",
                    },
                    "bundleRemaining": {
                      "type": "number",
                    },
                    "bundleTotal": {
                      "type": "number",
                    },
                  },
                  "required": [
                    "bundleTotal",
                    "bundleConsumed",
                    "bundleRemaining",
                  ],
                  "type": "object",
                },
                "createdAt": {},
                "credit": {
                  "additionalProperties": false,
                  "properties": {
                    "bonusCredits": {
                      "type": "number",
                    },
                    "consumedFromBonus": {
                      "type": "number",
                    },
                    "consumedFromPlan": {
                      "type": "number",
                    },
                    "customerId": {
                      "type": "string",
                    },
                    "id": {
                      "type": "string",
                    },
                    "lastResetAt": {},
                    "orgId": {
                      "type": "string",
                    },
                    "userId": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "id",
                    "userId",
                    "customerId",
                    "bonusCredits",
                    "consumedFromPlan",
                    "consumedFromBonus",
                    "lastResetAt",
                    "orgId",
                  ],
                  "type": "object",
                },
                "customerId": {
                  "type": "string",
                },
                "hasActiveBundle": {
                  "type": "boolean",
                },
                "hasPaymentMethod": {
                  "anyOf": [
                    {
                      "type": "boolean",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "id": {
                  "type": "string",
                },
                "isInTrial": {
                  "type": "boolean",
                },
                "orgID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "organization": {
                  "additionalProperties": false,
                  "properties": {
                    "createdAt": {},
                    "id": {
                      "type": "string",
                    },
                    "privacyMode": {
                      "type": "boolean",
                    },
                    "providerHandle": {
                      "type": "string",
                    },
                    "providerId": {
                      "type": "string",
                    },
                    "providerType": {
                      "enum": [
                        "GITHUB",
                        "GOOGLE",
                        "GITLAB",
                        "EMAIL",
                      ],
                      "type": "string",
                    },
                    "seatAllocation": {
                      "enum": [
                        "MANUAL",
                        "AUTO_ALLOCATION",
                      ],
                      "type": "string",
                    },
                    "updatedAt": {},
                  },
                  "required": [
                    "id",
                    "providerId",
                    "providerHandle",
                    "providerType",
                    "privacyMode",
                    "seatAllocation",
                    "createdAt",
                    "updatedAt",
                  ],
                  "type": "object",
                },
                "rechargeRateSeconds": {
                  "type": "number",
                },
                "subscriptionExpiry": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "subscriptionStatus": {
                  "enum": [
                    "PENDING",
                    "FREE",
                    "PRO_LEGACY",
                    "PRO",
                    "PRO_PLUS",
                    "LITE",
                    "LITE_V2",
                    "PRO_V2",
                    "PRO_PLUS_V2",
                    "LITE_V3",
                    "PRO_V3",
                    "ULTRA_1X_V3",
                    "ULTRA_2X_V3",
                    "ULTRA_3X_V3",
                    "ULTRA_4X_V3",
                    "ULTRA_5X_V3",
                    "BYOA_V3",
                  ],
                  "type": "string",
                },
                "teamID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "totalPlanCredits": {
                  "type": "number",
                },
                "trialEndsAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "updatedAt": {},
                "userID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
              },
              "required": [
                "id",
                "userID",
                "orgID",
                "teamID",
                "customerId",
                "createdAt",
                "updatedAt",
                "subscriptionExpiry",
                "trialEndsAt",
                "subscriptionStatus",
                "hasPaymentMethod",
                "isInTrial",
                "rechargeRateSeconds",
              ],
              "type": "object",
            },
            "organizationSubscriptions": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "bundleSummary": {
                    "additionalProperties": false,
                    "properties": {
                      "bundleConsumed": {
                        "type": "number",
                      },
                      "bundleRemaining": {
                        "type": "number",
                      },
                      "bundleTotal": {
                        "type": "number",
                      },
                    },
                    "required": [
                      "bundleTotal",
                      "bundleConsumed",
                      "bundleRemaining",
                    ],
                    "type": "object",
                  },
                  "createdAt": {},
                  "credit": {
                    "additionalProperties": false,
                    "properties": {
                      "bonusCredits": {
                        "type": "number",
                      },
                      "consumedFromBonus": {
                        "type": "number",
                      },
                      "consumedFromPlan": {
                        "type": "number",
                      },
                      "customerId": {
                        "type": "string",
                      },
                      "id": {
                        "type": "string",
                      },
                      "lastResetAt": {},
                      "orgId": {
                        "type": "string",
                      },
                      "userId": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "id",
                      "userId",
                      "customerId",
                      "bonusCredits",
                      "consumedFromPlan",
                      "consumedFromBonus",
                      "lastResetAt",
                      "orgId",
                    ],
                    "type": "object",
                  },
                  "customerId": {
                    "type": "string",
                  },
                  "hasActiveBundle": {
                    "type": "boolean",
                  },
                  "hasPaymentMethod": {
                    "anyOf": [
                      {
                        "type": "boolean",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "id": {
                    "type": "string",
                  },
                  "isInTrial": {
                    "type": "boolean",
                  },
                  "orgID": {
                    "anyOf": [
                      {
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "organization": {
                    "additionalProperties": false,
                    "properties": {
                      "createdAt": {},
                      "id": {
                        "type": "string",
                      },
                      "privacyMode": {
                        "type": "boolean",
                      },
                      "providerHandle": {
                        "type": "string",
                      },
                      "providerId": {
                        "type": "string",
                      },
                      "providerType": {
                        "enum": [
                          "GITHUB",
                          "GOOGLE",
                          "GITLAB",
                          "EMAIL",
                        ],
                        "type": "string",
                      },
                      "seatAllocation": {
                        "enum": [
                          "MANUAL",
                          "AUTO_ALLOCATION",
                        ],
                        "type": "string",
                      },
                      "updatedAt": {},
                    },
                    "required": [
                      "id",
                      "providerId",
                      "providerHandle",
                      "providerType",
                      "privacyMode",
                      "seatAllocation",
                      "createdAt",
                      "updatedAt",
                    ],
                    "type": "object",
                  },
                  "rechargeRateSeconds": {
                    "type": "number",
                  },
                  "subscriptionExpiry": {
                    "anyOf": [
                      {},
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "subscriptionStatus": {
                    "enum": [
                      "PENDING",
                      "FREE",
                      "PRO_LEGACY",
                      "PRO",
                      "PRO_PLUS",
                      "LITE",
                      "LITE_V2",
                      "PRO_V2",
                      "PRO_PLUS_V2",
                      "LITE_V3",
                      "PRO_V3",
                      "ULTRA_1X_V3",
                      "ULTRA_2X_V3",
                      "ULTRA_3X_V3",
                      "ULTRA_4X_V3",
                      "ULTRA_5X_V3",
                      "BYOA_V3",
                    ],
                    "type": "string",
                  },
                  "teamID": {
                    "anyOf": [
                      {
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "totalPlanCredits": {
                    "type": "number",
                  },
                  "trialEndsAt": {
                    "anyOf": [
                      {},
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "updatedAt": {},
                  "userID": {
                    "anyOf": [
                      {
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                },
                "required": [
                  "id",
                  "userID",
                  "orgID",
                  "teamID",
                  "customerId",
                  "createdAt",
                  "updatedAt",
                  "subscriptionExpiry",
                  "trialEndsAt",
                  "subscriptionStatus",
                  "hasPaymentMethod",
                  "isInTrial",
                  "rechargeRateSeconds",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "payAsYouGoUsage": {
              "additionalProperties": false,
              "properties": {
                "allowPayAsYouGo": {
                  "type": "boolean",
                },
              },
              "required": [
                "allowPayAsYouGo",
              ],
              "type": "object",
            },
            "rechargeRateSeconds": {
              "type": "number",
            },
            "user": {
              "additionalProperties": false,
              "properties": {
                "activatedAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "avatarUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "createdAt": {},
                "email": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "id": {
                  "type": "string",
                },
                "isLearningEnabled": {
                  "type": "boolean",
                },
                "lastSeenAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "name": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "privacyMode": {
                  "type": "boolean",
                },
                "providerHandle": {
                  "type": "string",
                },
                "providerId": {
                  "type": "string",
                },
                "providerType": {
                  "enum": [
                    "GITHUB",
                    "GOOGLE",
                    "GITLAB",
                    "EMAIL",
                  ],
                  "type": "string",
                },
                "updatedAt": {},
              },
              "required": [
                "id",
                "name",
                "providerId",
                "providerHandle",
                "providerType",
                "email",
                "avatarUrl",
                "activatedAt",
                "createdAt",
                "updatedAt",
                "lastSeenAt",
                "privacyMode",
                "isLearningEnabled",
              ],
              "type": "object",
            },
            "userSubscription": {
              "additionalProperties": false,
              "properties": {
                "bundleSummary": {
                  "additionalProperties": false,
                  "properties": {
                    "bundleConsumed": {
                      "type": "number",
                    },
                    "bundleRemaining": {
                      "type": "number",
                    },
                    "bundleTotal": {
                      "type": "number",
                    },
                  },
                  "required": [
                    "bundleTotal",
                    "bundleConsumed",
                    "bundleRemaining",
                  ],
                  "type": "object",
                },
                "createdAt": {},
                "credit": {
                  "additionalProperties": false,
                  "properties": {
                    "bonusCredits": {
                      "type": "number",
                    },
                    "consumedFromBonus": {
                      "type": "number",
                    },
                    "consumedFromPlan": {
                      "type": "number",
                    },
                    "customerId": {
                      "type": "string",
                    },
                    "id": {
                      "type": "string",
                    },
                    "lastResetAt": {},
                    "userId": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "id",
                    "userId",
                    "customerId",
                    "bonusCredits",
                    "consumedFromPlan",
                    "consumedFromBonus",
                    "lastResetAt",
                  ],
                  "type": "object",
                },
                "customerId": {
                  "type": "string",
                },
                "hasActiveBundle": {
                  "type": "boolean",
                },
                "hasPaymentMethod": {
                  "anyOf": [
                    {
                      "type": "boolean",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "id": {
                  "type": "string",
                },
                "isInTrial": {
                  "type": "boolean",
                },
                "orgID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "rechargeRateSeconds": {
                  "type": "number",
                },
                "subscriptionExpiry": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "subscriptionStatus": {
                  "enum": [
                    "PENDING",
                    "FREE",
                    "PRO_LEGACY",
                    "PRO",
                    "PRO_PLUS",
                    "LITE",
                    "LITE_V2",
                    "PRO_V2",
                    "PRO_PLUS_V2",
                    "LITE_V3",
                    "PRO_V3",
                    "ULTRA_1X_V3",
                    "ULTRA_2X_V3",
                    "ULTRA_3X_V3",
                    "ULTRA_4X_V3",
                    "ULTRA_5X_V3",
                    "BYOA_V3",
                  ],
                  "type": "string",
                },
                "teamID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "totalPlanCredits": {
                  "type": "number",
                },
                "trialEndsAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "updatedAt": {},
                "userID": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
              },
              "required": [
                "id",
                "userID",
                "orgID",
                "teamID",
                "customerId",
                "createdAt",
                "updatedAt",
                "subscriptionExpiry",
                "trialEndsAt",
                "subscriptionStatus",
                "hasPaymentMethod",
                "isInTrial",
                "rechargeRateSeconds",
              ],
              "type": "object",
            },
          },
          "required": [
            "user",
            "userSubscription",
            "payAsYouGoUsage",
            "rechargeRateSeconds",
          ],
          "type": "object",
        }
      `);
    });

    it("organization 1.0", () => {
      expect(
        toJsonSchemaFingerprint(organizationRecordV100.schema, "organization"),
      ).toMatchInlineSnapshot(`
        {
          "properties": {
            "createdAt": {},
            "id": {
              "type": "string",
            },
            "privacyMode": {
              "type": "boolean",
            },
            "providerHandle": {
              "type": "string",
            },
            "providerId": {
              "type": "string",
            },
            "providerType": {
              "enum": [
                "GITHUB",
                "GOOGLE",
                "GITLAB",
                "EMAIL",
              ],
              "type": "string",
            },
            "seatAllocation": {
              "enum": [
                "MANUAL",
                "AUTO_ALLOCATION",
              ],
              "type": "string",
            },
            "updatedAt": {},
          },
          "required": [
            "id",
            "providerId",
            "providerHandle",
            "providerType",
            "privacyMode",
            "seatAllocation",
            "createdAt",
            "updatedAt",
          ],
          "type": "object",
        }
      `);
    });

    it("provider-login-response 1.0", () => {
      expect(
        toJsonSchemaFingerprint(
          providerLoginResponseRecordV100.schema,
          "provider-login-response",
        ),
      ).toMatchInlineSnapshot(`
        {
          "properties": {
            "refreshToken": {
              "type": "string",
            },
            "token": {
              "type": "string",
            },
            "user": {
              "additionalProperties": false,
              "properties": {
                "activatedAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "avatarUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "createdAt": {},
                "email": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "id": {
                  "type": "string",
                },
                "isLearningEnabled": {
                  "type": "boolean",
                },
                "lastSeenAt": {
                  "anyOf": [
                    {},
                    {
                      "type": "null",
                    },
                  ],
                },
                "name": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "privacyMode": {
                  "type": "boolean",
                },
                "providerHandle": {
                  "type": "string",
                },
                "providerId": {
                  "type": "string",
                },
                "providerType": {
                  "enum": [
                    "GITHUB",
                    "GOOGLE",
                    "GITLAB",
                    "EMAIL",
                  ],
                  "type": "string",
                },
                "updatedAt": {},
              },
              "required": [
                "id",
                "name",
                "providerId",
                "providerHandle",
                "providerType",
                "email",
                "avatarUrl",
                "activatedAt",
                "createdAt",
                "updatedAt",
                "lastSeenAt",
                "privacyMode",
                "isLearningEnabled",
              ],
              "type": "object",
            },
          },
          "required": [
            "token",
            "user",
          ],
          "type": "object",
        }
      `);
    });

    it("exchange-token-response 1.0", () => {
      expect(
        toJsonSchemaFingerprint(
          exchangeTokenResponseRecordV100.schema,
          "exchange-token-response",
        ),
      ).toMatchInlineSnapshot(`
        {
          "properties": {
            "refreshToken": {
              "type": "string",
            },
            "token": {
              "type": "string",
            },
            "user": {
              "additionalProperties": false,
              "properties": {
                "hostId": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "null",
                    },
                  ],
                },
                "payAsYouGoUsage": {
                  "additionalProperties": false,
                  "properties": {
                    "allowPayAsYouGo": {
                      "type": "boolean",
                    },
                  },
                  "required": [
                    "allowPayAsYouGo",
                  ],
                  "type": "object",
                },
                "teamSubscriptions": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "bundleSummary": {
                        "additionalProperties": false,
                        "properties": {
                          "bundleConsumed": {
                            "type": "number",
                          },
                          "bundleRemaining": {
                            "type": "number",
                          },
                          "bundleTotal": {
                            "type": "number",
                          },
                        },
                        "required": [
                          "bundleTotal",
                          "bundleConsumed",
                          "bundleRemaining",
                        ],
                        "type": "object",
                      },
                      "createdAt": {},
                      "credit": {
                        "additionalProperties": false,
                        "properties": {
                          "bonusCredits": {
                            "type": "number",
                          },
                          "consumedFromBonus": {
                            "type": "number",
                          },
                          "consumedFromPlan": {
                            "type": "number",
                          },
                          "customerId": {
                            "type": "string",
                          },
                          "id": {
                            "type": "string",
                          },
                          "lastResetAt": {},
                          "orgId": {
                            "type": "string",
                          },
                          "userId": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "id",
                          "userId",
                          "customerId",
                          "bonusCredits",
                          "consumedFromPlan",
                          "consumedFromBonus",
                          "lastResetAt",
                          "orgId",
                        ],
                        "type": "object",
                      },
                      "customerId": {
                        "type": "string",
                      },
                      "hasActiveBundle": {
                        "type": "boolean",
                      },
                      "hasPaymentMethod": {
                        "anyOf": [
                          {
                            "type": "boolean",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "id": {
                        "type": "string",
                      },
                      "isInTrial": {
                        "type": "boolean",
                      },
                      "orgID": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "rechargeRateSeconds": {
                        "type": "number",
                      },
                      "subscriptionExpiry": {
                        "anyOf": [
                          {},
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "subscriptionStatus": {
                        "enum": [
                          "PENDING",
                          "FREE",
                          "PRO_LEGACY",
                          "PRO",
                          "PRO_PLUS",
                          "LITE",
                          "LITE_V2",
                          "PRO_V2",
                          "PRO_PLUS_V2",
                          "LITE_V3",
                          "PRO_V3",
                          "ULTRA_1X_V3",
                          "ULTRA_2X_V3",
                          "ULTRA_3X_V3",
                          "ULTRA_4X_V3",
                          "ULTRA_5X_V3",
                          "BYOA_V3",
                        ],
                        "type": "string",
                      },
                      "team": {
                        "additionalProperties": false,
                        "properties": {
                          "avatarUrl": {
                            "anyOf": [
                              {
                                "type": "string",
                              },
                              {
                                "type": "null",
                              },
                            ],
                          },
                          "createdAt": {},
                          "id": {
                            "type": "string",
                          },
                          "privacyMode": {
                            "type": "boolean",
                          },
                          "slug": {
                            "type": "string",
                          },
                          "updatedAt": {},
                        },
                        "required": [
                          "id",
                          "slug",
                          "avatarUrl",
                          "privacyMode",
                          "createdAt",
                          "updatedAt",
                        ],
                        "type": "object",
                      },
                      "teamID": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "totalPlanCredits": {
                        "type": "number",
                      },
                      "trialEndsAt": {
                        "anyOf": [
                          {},
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "updatedAt": {},
                      "userID": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                    },
                    "required": [
                      "id",
                      "userID",
                      "orgID",
                      "teamID",
                      "customerId",
                      "createdAt",
                      "updatedAt",
                      "subscriptionExpiry",
                      "trialEndsAt",
                      "subscriptionStatus",
                      "hasPaymentMethod",
                      "team",
                      "isInTrial",
                      "bundleSummary",
                      "totalPlanCredits",
                      "rechargeRateSeconds",
                      "hasActiveBundle",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "user": {
                  "additionalProperties": false,
                  "properties": {
                    "activatedAt": {
                      "anyOf": [
                        {},
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "avatarUrl": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "createdAt": {},
                    "email": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "id": {
                      "type": "string",
                    },
                    "isLearningEnabled": {
                      "type": "boolean",
                    },
                    "lastSeenAt": {
                      "anyOf": [
                        {},
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "name": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "privacyMode": {
                      "type": "boolean",
                    },
                    "providerHandle": {
                      "type": "string",
                    },
                    "providerId": {
                      "type": "string",
                    },
                    "providerType": {
                      "enum": [
                        "GITHUB",
                        "GOOGLE",
                        "GITLAB",
                        "EMAIL",
                      ],
                      "type": "string",
                    },
                    "updatedAt": {},
                  },
                  "required": [
                    "id",
                    "name",
                    "providerId",
                    "providerHandle",
                    "providerType",
                    "email",
                    "avatarUrl",
                    "activatedAt",
                    "createdAt",
                    "updatedAt",
                    "lastSeenAt",
                    "privacyMode",
                    "isLearningEnabled",
                  ],
                  "type": "object",
                },
                "userSubscription": {
                  "additionalProperties": false,
                  "properties": {
                    "bundleSummary": {
                      "additionalProperties": false,
                      "properties": {
                        "bundleConsumed": {
                          "type": "number",
                        },
                        "bundleRemaining": {
                          "type": "number",
                        },
                        "bundleTotal": {
                          "type": "number",
                        },
                      },
                      "required": [
                        "bundleTotal",
                        "bundleConsumed",
                        "bundleRemaining",
                      ],
                      "type": "object",
                    },
                    "createdAt": {},
                    "credit": {
                      "additionalProperties": false,
                      "properties": {
                        "bonusCredits": {
                          "type": "number",
                        },
                        "consumedFromBonus": {
                          "type": "number",
                        },
                        "consumedFromPlan": {
                          "type": "number",
                        },
                        "customerId": {
                          "type": "string",
                        },
                        "id": {
                          "type": "string",
                        },
                        "lastResetAt": {},
                        "userId": {
                          "type": "string",
                        },
                      },
                      "required": [
                        "id",
                        "userId",
                        "customerId",
                        "bonusCredits",
                        "consumedFromPlan",
                        "consumedFromBonus",
                        "lastResetAt",
                      ],
                      "type": "object",
                    },
                    "customerId": {
                      "type": "string",
                    },
                    "hasActiveBundle": {
                      "type": "boolean",
                    },
                    "hasPaymentMethod": {
                      "anyOf": [
                        {
                          "type": "boolean",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "id": {
                      "type": "string",
                    },
                    "isInTrial": {
                      "type": "boolean",
                    },
                    "orgID": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "rechargeRateSeconds": {
                      "type": "number",
                    },
                    "subscriptionExpiry": {
                      "anyOf": [
                        {},
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "subscriptionStatus": {
                      "enum": [
                        "PENDING",
                        "FREE",
                        "PRO_LEGACY",
                        "PRO",
                        "PRO_PLUS",
                        "LITE",
                        "LITE_V2",
                        "PRO_V2",
                        "PRO_PLUS_V2",
                        "LITE_V3",
                        "PRO_V3",
                        "ULTRA_1X_V3",
                        "ULTRA_2X_V3",
                        "ULTRA_3X_V3",
                        "ULTRA_4X_V3",
                        "ULTRA_5X_V3",
                        "BYOA_V3",
                      ],
                      "type": "string",
                    },
                    "teamID": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "totalPlanCredits": {
                      "type": "number",
                    },
                    "trialEndsAt": {
                      "anyOf": [
                        {},
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "updatedAt": {},
                    "userID": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                  },
                  "required": [
                    "id",
                    "userID",
                    "orgID",
                    "teamID",
                    "customerId",
                    "createdAt",
                    "updatedAt",
                    "subscriptionExpiry",
                    "trialEndsAt",
                    "subscriptionStatus",
                    "hasPaymentMethod",
                    "isInTrial",
                    "rechargeRateSeconds",
                  ],
                  "type": "object",
                },
              },
              "required": [
                "user",
                "userSubscription",
                "payAsYouGoUsage",
                "teamSubscriptions",
              ],
              "type": "object",
            },
          },
          "required": [
            "token",
            "user",
          ],
          "type": "object",
        }
      `);
    });

    it("list-all-mcp-servers-response 1.0", () => {
      expect(
        toJsonSchemaFingerprint(
          listAllMcpServersResponseRecordV100.schema,
          "list-all-mcp-servers-response",
        ),
      ).toMatchInlineSnapshot(`
        {
          "properties": {
            "organizations": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "organization": {
                    "additionalProperties": false,
                    "properties": {
                      "createdAt": {},
                      "id": {
                        "type": "string",
                      },
                      "privacyMode": {
                        "type": "boolean",
                      },
                      "providerHandle": {
                        "type": "string",
                      },
                      "providerId": {
                        "type": "string",
                      },
                      "providerType": {
                        "enum": [
                          "GITHUB",
                          "GOOGLE",
                          "GITLAB",
                          "EMAIL",
                        ],
                        "type": "string",
                      },
                      "seatAllocation": {
                        "enum": [
                          "MANUAL",
                          "AUTO_ALLOCATION",
                        ],
                        "type": "string",
                      },
                      "updatedAt": {},
                    },
                    "required": [
                      "id",
                      "providerId",
                      "providerHandle",
                      "providerType",
                      "privacyMode",
                      "seatAllocation",
                      "createdAt",
                      "updatedAt",
                    ],
                    "type": "object",
                  },
                  "servers": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "authType": {
                          "enum": [
                            "NO_AUTH",
                            "PAT",
                            "OAUTH",
                          ],
                          "type": "string",
                        },
                        "createdAt": {},
                        "customHeaderKeys": {
                          "items": {
                            "type": "string",
                          },
                          "type": "array",
                        },
                        "customHeadersEncrypted": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "customHeadersIV": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "customHeadersTag": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "enabledToolNames": {},
                        "id": {
                          "type": "string",
                        },
                        "instructions": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "isConsentGiven": {
                          "type": "boolean",
                        },
                        "name": {
                          "type": "string",
                        },
                        "oauthAccessTokenEncrypted": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthAccessTokenExpiresAt": {
                          "anyOf": [
                            {},
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthAccessTokenIV": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthAccessTokenTag": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthClientId": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthClientSecretEncrypted": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthClientSecretIV": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthClientSecretTag": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthRefreshTokenEncrypted": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthRefreshTokenIV": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "oauthRefreshTokenTag": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "orgId": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "patEncrypted": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "patIV": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "patTag": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "status": {
                          "enum": [
                            "CONNECTED",
                            "CONNECTING",
                            "DISCONNECTED",
                            "UNAUTHORIZED",
                            "AUTHORIZING",
                            "AUTHORIZATION_FAILED",
                          ],
                          "type": "string",
                        },
                        "teamId": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                        "tools": {
                          "items": {
                            "additionalProperties": false,
                            "properties": {
                              "description": {
                                "type": "string",
                              },
                              "inputSchema": {
                                "additionalProperties": {},
                                "propertyNames": {
                                  "type": "string",
                                },
                                "type": "object",
                              },
                              "name": {
                                "type": "string",
                              },
                              "outputSchema": {
                                "additionalProperties": {},
                                "propertyNames": {
                                  "type": "string",
                                },
                                "type": "object",
                              },
                            },
                            "required": [
                              "name",
                              "description",
                              "inputSchema",
                            ],
                            "type": "object",
                          },
                          "type": "array",
                        },
                        "updatedAt": {},
                        "url": {
                          "type": "string",
                        },
                        "userId": {
                          "anyOf": [
                            {
                              "type": "string",
                            },
                            {
                              "type": "null",
                            },
                          ],
                        },
                      },
                      "required": [
                        "id",
                        "name",
                        "url",
                        "status",
                        "userId",
                        "orgId",
                        "teamId",
                        "isConsentGiven",
                        "authType",
                        "patEncrypted",
                        "patIV",
                        "patTag",
                        "customHeadersEncrypted",
                        "customHeadersIV",
                        "customHeadersTag",
                        "oauthAccessTokenEncrypted",
                        "oauthAccessTokenIV",
                        "oauthAccessTokenTag",
                        "oauthAccessTokenExpiresAt",
                        "oauthRefreshTokenEncrypted",
                        "oauthRefreshTokenIV",
                        "oauthRefreshTokenTag",
                        "oauthClientId",
                        "oauthClientSecretEncrypted",
                        "oauthClientSecretIV",
                        "oauthClientSecretTag",
                        "enabledToolNames",
                        "createdAt",
                        "updatedAt",
                        "tools",
                        "instructions",
                        "customHeaderKeys",
                      ],
                      "type": "object",
                    },
                    "type": "array",
                  },
                },
                "required": [
                  "organization",
                  "servers",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "user": {
              "additionalProperties": false,
              "properties": {
                "servers": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "authType": {
                        "enum": [
                          "NO_AUTH",
                          "PAT",
                          "OAUTH",
                        ],
                        "type": "string",
                      },
                      "createdAt": {},
                      "customHeaderKeys": {
                        "items": {
                          "type": "string",
                        },
                        "type": "array",
                      },
                      "customHeadersEncrypted": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "customHeadersIV": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "customHeadersTag": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "enabledToolNames": {},
                      "id": {
                        "type": "string",
                      },
                      "instructions": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "isConsentGiven": {
                        "type": "boolean",
                      },
                      "name": {
                        "type": "string",
                      },
                      "oauthAccessTokenEncrypted": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthAccessTokenExpiresAt": {
                        "anyOf": [
                          {},
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthAccessTokenIV": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthAccessTokenTag": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthClientId": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthClientSecretEncrypted": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthClientSecretIV": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthClientSecretTag": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthRefreshTokenEncrypted": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthRefreshTokenIV": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "oauthRefreshTokenTag": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "orgId": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "patEncrypted": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "patIV": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "patTag": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "status": {
                        "enum": [
                          "CONNECTED",
                          "CONNECTING",
                          "DISCONNECTED",
                          "UNAUTHORIZED",
                          "AUTHORIZING",
                          "AUTHORIZATION_FAILED",
                        ],
                        "type": "string",
                      },
                      "teamId": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "tools": {
                        "items": {
                          "additionalProperties": false,
                          "properties": {
                            "description": {
                              "type": "string",
                            },
                            "inputSchema": {
                              "additionalProperties": {},
                              "propertyNames": {
                                "type": "string",
                              },
                              "type": "object",
                            },
                            "name": {
                              "type": "string",
                            },
                            "outputSchema": {
                              "additionalProperties": {},
                              "propertyNames": {
                                "type": "string",
                              },
                              "type": "object",
                            },
                          },
                          "required": [
                            "name",
                            "description",
                            "inputSchema",
                          ],
                          "type": "object",
                        },
                        "type": "array",
                      },
                      "updatedAt": {},
                      "url": {
                        "type": "string",
                      },
                      "userId": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                    },
                    "required": [
                      "id",
                      "name",
                      "url",
                      "status",
                      "userId",
                      "orgId",
                      "teamId",
                      "isConsentGiven",
                      "authType",
                      "patEncrypted",
                      "patIV",
                      "patTag",
                      "customHeadersEncrypted",
                      "customHeadersIV",
                      "customHeadersTag",
                      "oauthAccessTokenEncrypted",
                      "oauthAccessTokenIV",
                      "oauthAccessTokenTag",
                      "oauthAccessTokenExpiresAt",
                      "oauthRefreshTokenEncrypted",
                      "oauthRefreshTokenIV",
                      "oauthRefreshTokenTag",
                      "oauthClientId",
                      "oauthClientSecretEncrypted",
                      "oauthClientSecretIV",
                      "oauthClientSecretTag",
                      "enabledToolNames",
                      "createdAt",
                      "updatedAt",
                      "tools",
                      "instructions",
                      "customHeaderKeys",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "user": {
                  "additionalProperties": false,
                  "properties": {
                    "activatedAt": {
                      "anyOf": [
                        {},
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "avatarUrl": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "createdAt": {},
                    "email": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "id": {
                      "type": "string",
                    },
                    "isLearningEnabled": {
                      "type": "boolean",
                    },
                    "lastSeenAt": {
                      "anyOf": [
                        {},
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "name": {
                      "anyOf": [
                        {
                          "type": "string",
                        },
                        {
                          "type": "null",
                        },
                      ],
                    },
                    "privacyMode": {
                      "type": "boolean",
                    },
                    "providerHandle": {
                      "type": "string",
                    },
                    "providerId": {
                      "type": "string",
                    },
                    "providerType": {
                      "enum": [
                        "GITHUB",
                        "GOOGLE",
                        "GITLAB",
                        "EMAIL",
                      ],
                      "type": "string",
                    },
                    "updatedAt": {},
                  },
                  "required": [
                    "id",
                    "name",
                    "providerId",
                    "providerHandle",
                    "providerType",
                    "email",
                    "avatarUrl",
                    "activatedAt",
                    "createdAt",
                    "updatedAt",
                    "lastSeenAt",
                    "privacyMode",
                    "isLearningEnabled",
                  ],
                  "type": "object",
                },
              },
              "required": [
                "user",
                "servers",
              ],
              "type": "object",
            },
          },
          "required": [
            "user",
            "organizations",
          ],
          "type": "object",
        }
      `);
    });
  });
});
