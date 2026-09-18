import { describe, expect, it } from "vitest";
import { z } from "zod";
import { downgradeResponseAcrossMajors } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { projectOntoFrozenLine } from "@traycer/protocol/host/frozen-line-projection";
import {
  downgradeProviderCliStateListToV70,
  downgradeProviderCliStateListToV80,
  providerCliStateSchema,
  providerCliStateSchemaV70,
  providerCliStateSchemaV80,
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV91,
} from "@traycer/protocol/host/provider-schemas";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE,
  providerNativeCapabilitiesSchema,
  providerNativeCapabilitiesSchemaV70Preimage,
} from "@traycer/protocol/host/provider-native-schemas";

/**
 * A downgrade bridge reparses the live response through the frozen schema of
 * the line it serves. That reparse strips an added KEY correctly and handles an
 * added ENUM MEMBER catastrophically: `z.array(enum)` rejects the whole array
 * over one unknown element, and the nearest `.catch()` then serves its default
 * in place of everything that array was nested inside.
 *
 * Every test below therefore states BOTH halves - what the frozen schema does
 * to the value on its own (the control, which is the behaviour that shipped)
 * and what it does after {@link projectOntoFrozenLine}. Without the control a
 * green assertion here would not distinguish "the projection saved the
 * siblings" from "there was nothing to save".
 */

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
  };
}

function nativeMcpResultWithDenySources(denySources: readonly string[]) {
  return {
    kind: "mcp",
    ok: true,
    servers: [
      {
        name: "s",
        enabled: true,
        status: "connected",
        statusDetail: null,
        statusSource: "native",
        configOnly: false,
        discoveryPending: false,
        stdioDegraded: false,
        instructions: null,
        transport: { type: "stdio", command: "x", env: null },
        tools: [
          {
            name: "t",
            description: null,
            inputSchema: null,
            enabled: true,
            readOnly: false,
            denySources,
          },
        ],
      },
    ],
  };
}

type EnumWalkDef = z.core.$ZodTypeDef & {
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly options?: readonly z.ZodType[];
};

function collectEnumMembers(
  schema: z.ZodType,
  path: string,
  out: Map<string, readonly string[]>,
  depth: number,
): void {
  if (depth > 40) return;
  const def: EnumWalkDef = schema._zod.def;
  switch (def.type) {
    case "enum":
      out.set(path, Object.keys((def as { entries?: object }).entries ?? {}));
      return;
    case "catch":
    case "optional":
    case "nullable":
    case "default":
    case "nonoptional":
    case "readonly":
      if (def.innerType)
        collectEnumMembers(def.innerType, path, out, depth + 1);
      return;
    case "array":
      if (def.element) {
        collectEnumMembers(def.element, `${path}[]`, out, depth + 1);
      }
      return;
    case "object":
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        collectEnumMembers(
          child,
          path ? `${path}.${key}` : key,
          out,
          depth + 1,
        );
      }
      return;
    case "union":
      (def.options ?? []).forEach((arm, index) => {
        collectEnumMembers(arm, `${path}|${index}`, out, depth + 1);
      });
      return;
    case "record":
      if (def.valueType) {
        collectEnumMembers(def.valueType, `${path}{}`, out, depth + 1);
      }
      return;
    default:
      return;
  }
}

/**
 * Paths where `row`'s enum admits strictly FEWER members than the head row does
 * at the same path - the only places the projection can ever drop anything,
 * because the host has already parsed the value against the head.
 */
function strictlyNarrowerEnumPaths(row: z.ZodType): string[] {
  const head = new Map<string, readonly string[]>();
  collectEnumMembers(providersListResponseSchema, "", head, 0);
  const rowEnums = new Map<string, readonly string[]>();
  collectEnumMembers(row, "", rowEnums, 0);
  const narrower: string[] = [];
  for (const [path, members] of rowEnums) {
    const headMembers = head.get(path);
    if (!headMembers) continue;
    if (
      members.length < headMembers.length &&
      members.every((member) => headMembers.includes(member))
    ) {
      narrower.push(path);
    }
  }
  return narrower;
}

describe("projectOntoFrozenLine", () => {
  it("returns an already-valid value by identity, without copying it", () => {
    // The overwhelmingly common case: nothing has drifted. It must cost one
    // parse and must not clone a whole provider list to achieve nothing.
    const valid = {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general", "mcp"],
    };
    expect(projectOntoFrozenLine(providerNativeCapabilitiesSchema, valid)).toBe(
      valid,
    );
  });

  it("leaves a value it cannot repair untouched, so the caller's catch still rules", () => {
    // A SCALAR enum has no member to drop. Inventing a substitute would be a
    // bridge fabricating wire content, so the value passes through unchanged
    // and the existing `.catch()` handles it exactly as it does today.
    const unrepairable = {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general"],
      envOverrideScope: "not-a-real-scope",
    };
    const projected = projectOntoFrozenLine(
      providerNativeCapabilitiesSchemaV70Preimage,
      unrepairable,
    );
    expect(projected).toMatchObject({ envOverrideScope: "not-a-real-scope" });
    expect(
      providerNativeCapabilitiesSchemaV70Preimage
        .catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE)
        .parse(projected).supportedTabs,
    ).toEqual(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE.supportedTabs);
  });

  it("picks the union arm that keeps the most, in either arm order", () => {
    // Overlapping arms are the case where "first arm that parses" silently
    // loses data: the narrow arm ACCEPTS the value once its extra member has
    // been dropped, so it looks like a valid answer while a better one existed.
    // Today's real unions here are discriminated, so at most one arm can match
    // - this keeps that from becoming an unstated precondition.
    const narrow = z.object({ items: z.array(z.enum(["a"])) });
    const wide = z.object({ items: z.array(z.enum(["a", "b"])) });
    const value = { items: ["a", "b"] };

    // The narrow arm alone does lose "b" - so the fixture really is the trap.
    expect(projectOntoFrozenLine(narrow, value)).toEqual({ items: ["a"] });

    for (const union of [z.union([narrow, wide]), z.union([wide, narrow])]) {
      expect(projectOntoFrozenLine(union, value)).toEqual({
        items: ["a", "b"],
      });
    }
  });

  it("scores arms by what SURVIVES when every arm needs repair", () => {
    // The test above never reaches the scoring branch: `wide` matches
    // unchanged, so the identity short-circuit fires first. Here BOTH arms have
    // to drop something, which is the only way the comparison runs at all.
    const three = z.object({ items: z.array(z.enum(["a", "b", "c"])) });
    const one = z.object({ items: z.array(z.enum(["a"])) });
    const value = { items: ["a", "b", "c", "d"] };

    for (const union of [z.union([one, three]), z.union([three, one])]) {
      expect(projectOntoFrozenLine(union, value)).toEqual({
        items: ["a", "b", "c"],
      });
    }
  });

  it("scores what an arm KEEPS, not what it was handed", () => {
    // An arm strips the keys it does not model, so scoring the projected INPUT
    // credits an arm for data it is about to throw away. Here the narrow arm
    // carries a fat unmodeled field: scored on input it wins with 4 and the
    // peer receives `{items:["a"]}`; scored on output it correctly loses.
    const modelsBoth = z.object({
      items: z.array(z.enum(["a", "b"])),
      junk: z.array(z.enum(["x"])),
    });
    const modelsItemsOnly = z.object({ items: z.array(z.enum(["a"])) });
    const value = { items: ["a", "b"], junk: ["x", "y", "z"] };

    for (const union of [
      z.union([modelsBoth, modelsItemsOnly]),
      z.union([modelsItemsOnly, modelsBoth]),
    ]) {
      expect(projectOntoFrozenLine(union, value)).toMatchObject({
        items: ["a", "b"],
      });
    }
  });

  it("lets an arm needing NO repair compete, rather than win outright", () => {
    // The identity short-circuit used to return `value` the moment any arm
    // accepted it unchanged, on the reasoning that "identity means the value
    // already belongs to it". That is the same mistake as scoring the arm
    // instead of the union: belonging to SOME arm says nothing about what
    // first-match resolution of the UNREPAIRED value retains - and it threw
    // away a better candidate the loop had already computed.
    const armP = z.object({
      items: z.array(z.enum(["a"])),
      extra: z.array(z.enum(["x"])),
    });
    const armQ = z.object({ items: z.array(z.enum(["a", "b"])) });
    const union = z.union([armP, armQ]);
    const value = { items: ["a"], extra: ["x", "y"] };

    // armQ accepts `value` untouched, so the short-circuit would have fired
    // here and served one element. armP's repair survives the union with two.
    const served = union.safeParse(projectOntoFrozenLine(union, value));
    expect(served.success).toBe(true);
    if (!served.success) return;
    expect(served.data).toEqual({ items: ["a"], extra: ["x"] });
  });

  it("still returns an undrifted value by identity, via the tie-break", () => {
    // Removing the short-circuit must not cost the no-copy property: when
    // nothing needed repairing the unrepaired value ties on score and the
    // tie-break prefers it, so the caller still gets the same object back.
    const union = z.union([
      z.object({ items: z.array(z.enum(["a"])) }),
      z.object({ items: z.array(z.enum(["a", "b"])) }),
    ]);
    const clean = { items: ["a"] };
    expect(projectOntoFrozenLine(union, clean)).toBe(clean);
  });

  it("is scored on what the UNION resolves to, not on the arm that won", () => {
    // Every union test above asserts on the PROJECTION. That is the wrong end
    // of the pipe: the caller re-parses through the same union, and a union
    // resolves FIRST-MATCH-WINS in declaration order - so the arm that wins the
    // score is not necessarily the arm that serves the value.
    //
    // Scoring `arm.safeParse(...)` made this concretely worse than picking an
    // arm at random would have:
    //
    //   projection chose  {items:["a"], extra:[...]}   (armB, scored 4 vs 2)
    //   union.parse gave  {items:["a"]}                 (armA matched FIRST)
    //   armA alone gave   {items:["a","b"]}             (strictly better)
    //
    // Asserting through the final parse is the only framing that can see it,
    // which is why this test exists rather than another projection assertion.
    const armA = z.object({ items: z.array(z.enum(["a", "b"])) });
    const armB = z.object({
      items: z.array(z.enum(["a"])),
      extra: z.array(z.enum(["x"])),
    });
    const union = z.union([armA, armB]);
    const value = { items: ["a", "b", "c"], extra: ["x", "x", "x"] };

    const served = union.safeParse(projectOntoFrozenLine(union, value));
    expect(served.success).toBe(true);
    if (!served.success) return;
    expect(served.data).toEqual({ items: ["a", "b"] });

    // And the same assertion through the fixtures above, so the parse-through
    // framing covers the whole branch rather than only its regression.
    const three = z.object({ items: z.array(z.enum(["a", "b", "c"])) });
    const one = z.object({ items: z.array(z.enum(["a"])) });
    for (const u of [z.union([one, three]), z.union([three, one])]) {
      expect(
        u.parse(projectOntoFrozenLine(u, { items: ["a", "b", "c", "d"] })),
      ).toEqual({ items: ["a", "b", "c"] });
    }
  });

  it("never empties a non-empty array, because [] is a positive claim", () => {
    // `profiles[].rateLimitLimitedScopes` reads `null` as "could not determine,
    // fall back to rateLimitStatus" and `[]` as "determined: nothing limited".
    // Emptying it would turn "this model is rate limited" into a confident
    // "not limited"; leaving it lets the enclosing `.catch()` say "unknown".
    // Degrading to unknown is allowed, asserting a falsehood is not.
    const schema = z.object({ scopes: z.array(z.enum(["known"])) });
    const allUnrepresentable = { scopes: ["future-a", "future-b"] };
    expect(projectOntoFrozenLine(schema, allUnrepresentable)).toBe(
      allUnrepresentable,
    );

    // A PARTIAL drop is still the right thing - the survivors are real.
    expect(
      projectOntoFrozenLine(schema, { scopes: ["known", "future-a"] }),
    ).toEqual({ scopes: ["known"] });

    // And an array that was already empty stays empty rather than being
    // mistaken for one this rule has to protect.
    expect(projectOntoFrozenLine(schema, { scopes: [] })).toEqual({
      scopes: [],
    });
  });

  it("drops one unknown tab instead of the whole capability object", () => {
    // `modelProviders` is a real member the live tab enum has and the frozen
    // pre-image enum does not - a growth that already happened, so this is a
    // natural experiment rather than an invented value.
    const grown = {
      ...DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
      supportedTabs: ["general", "mcp", "modelProviders"],
    };

    // CONTROL: the reparse alone. One unknown member costs the peer every tab.
    expect(
      providerNativeCapabilitiesSchemaV70Preimage
        .catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE)
        .parse(grown).supportedTabs,
    ).toEqual(["general", "env", "usage"]);

    // With the projection the peer keeps the tabs its own build understands.
    const projected = projectOntoFrozenLine(
      providerNativeCapabilitiesSchemaV70Preimage,
      grown,
    );
    expect(
      providerNativeCapabilitiesSchemaV70Preimage
        .catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES_V70_PREIMAGE)
        .parse(projected).supportedTabs,
    ).toEqual(["general", "mcp"]);
  });
});

describe("providers.list downgrade keeps what a frozen line CAN represent", () => {
  it("keeps the shared-pack ids a v8.0 peer knows when one id is newer than the line", () => {
    // Reachable TODAY, with no invented values: `antigravity` is a live
    // provider id that `providers.list@8.0` does not carry, and a pack shared
    // between it and `claude-code` is an ordinary host response.
    const state = {
      ...providerState("claude-code"),
      packId: "pack-a",
      managedVersions: {
        autoDownload: true,
        pinnedVersion: null,
        updateAvailable: null,
        sharedWithProviders: ["claude-code", "antigravity"],
        totalSizeBytes: null,
        available: [],
      },
    };

    // CONTROL: `sharedWithProviders` is `z.array(providerId).catch([])`, so the
    // unknown id costs the peer the id it DID know as well.
    const withoutProjection = providerCliStateSchemaV80.parse(state);
    expect(withoutProjection.managedVersions?.sharedWithProviders).toEqual([]);

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      8,
      providersListResponseSchema.parse({ providers: [state], native: null }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    const row = downgraded.value.providers[0];
    expect(row?.managedVersions?.sharedWithProviders).toEqual(["claude-code"]);
  });

  it("drops only the newer id for a v7.0 peer, which is two majors behind", () => {
    const state = {
      ...providerState("claude-code"),
      packId: "pack-a",
      managedVersions: {
        autoDownload: true,
        pinnedVersion: null,
        updateAvailable: null,
        // v7.0 lacks BOTH of these; the projection must drop both and keep the
        // one it knows rather than stopping at the first failure.
        sharedWithProviders: ["claude-code", "reasonix", "antigravity"],
        totalSizeBytes: null,
        available: [],
      },
    };
    expect(
      providerCliStateSchemaV70.parse(state).managedVersions
        ?.sharedWithProviders,
    ).toEqual([]);

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      7,
      providersListResponseSchema.parse({ providers: [state], native: null }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(
      downgraded.value.providers[0]?.managedVersions?.sharedWithProviders,
    ).toEqual(["claude-code"]);
  });

  it("survives the v7.0 enabled-profiles PRE-PASS, which parses live first", () => {
    // Raised in review, and a reasonable-looking reading: the v7.0 bridge runs
    // `parseProviderStateWithEnabledProfiles` BEFORE the projection, that
    // pre-pass parses with a schema whose `sharedWithProviders` is
    // `z.array(providerIdSchema).catch([])`, and a `.catch([])` upstream of the
    // projection would hand it an already-emptied array - nothing left to keep.
    //
    // It does not happen, and the reason is worth stating because the reading
    // error is the easy one to make: the pre-pass parses with the LIVE schema,
    // and "newer than v7.0" is not "unknown to live". `antigravity` is in the
    // live enum, so the live `.catch([])` never fires; only the frozen v7.0
    // enum refuses it, and by then the projection is the thing doing the
    // refusing. The pre-pass is inert here BY CONSTRUCTION - it shares its
    // schema with the head parse that already gated this value.
    //
    // v8.0 is the control: same assertion, no pre-pass at all. If the pre-pass
    // were the hazard, these two would disagree.
    const shared = ["claude-code", "antigravity"];
    const state = {
      ...providerState("claude-code"),
      packId: "pack-a",
      managedVersions: {
        autoDownload: true,
        pinnedVersion: null,
        updateAvailable: null,
        sharedWithProviders: shared,
        totalSizeBytes: null,
        available: [],
      },
    };

    // The precondition the whole argument rests on: live accepts BOTH ids, so
    // the pre-pass has nothing to catch. Asserted, not assumed - if a future
    // edit narrows the live enum this test must fail loudly rather than pass
    // for a new reason.
    expect(
      providerCliStateSchema.parse(state).managedVersions?.sharedWithProviders,
    ).toEqual(shared);

    expect(
      downgradeProviderCliStateListToV70([state])[0]?.managedVersions
        ?.sharedWithProviders,
    ).toEqual(["claude-code"]);
    expect(
      downgradeProviderCliStateListToV80([state])[0]?.managedVersions
        ?.sharedWithProviders,
    ).toEqual(["claude-code"]);
  });

  it("is ARMED only by a pin, and today that is one leaf - proven, not assumed", () => {
    // This test replaced one that "rescued" a grown `denySources` member. That
    // test was vacuous, and the reason is the whole precondition of this
    // mechanism: the host parses the resolver result against the CANONICAL
    // (head) schema and 500s on failure BEFORE any downgrade runs
    // (`traycer-host/src/transport/rpc/handler.ts`, `canonicalResultParse`). So
    // a value only ever reaches the projection if the head already accepted it.
    const unreachable = {
      providers: [],
      native: nativeMcpResultWithDenySources(["user", "future-source"]),
    };
    expect(providersListResponseSchema.safeParse(unreachable).success).toBe(
      false,
    );

    // The consequence: where a frozen row binds the SAME enum object as the
    // head, it accepts exactly what the head accepts and the walk drops
    // nothing. Only a leaf pinned STRICTLY NARROWER than the head can ever be
    // acted on - so that set is the mechanism's live surface, and it belongs in
    // a test rather than in a claim.
    const narrower = strictlyNarrowerEnumPaths(providersListResponseSchemaV70);
    expect(narrower).toEqual([
      // A scalar: the row is dropped, exactly as it always was.
      "providers[].providerId",
      // The one field this actually changes today.
      "providers[].managedVersions.sharedWithProviders[]",
    ]);

    // 9.1 shares every enum object with the head, so nothing on it is armed
    // yet. The four pins it carries are byte-identical to live by design; they
    // arm the day the live enum moves, and not before.
    expect(strictlyNarrowerEnumPaths(providersListResponseSchemaV91)).toEqual(
      [],
    );
  });

  it("still drops a whole row when the row itself is unrepresentable", () => {
    // The projection must not rescue what the freeze exists to exclude: a
    // post-v7.0 provider id is a SCALAR on the row, so the row still fails and
    // the bridge still filters it out. This is the behaviour that keeps new
    // providers off an already-shipped wire.
    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      9,
      7,
      providersListResponseSchema.parse({
        providers: [providerState("claude-code"), providerState("antigravity")],
        native: null,
      }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
    ]);
  });
});
