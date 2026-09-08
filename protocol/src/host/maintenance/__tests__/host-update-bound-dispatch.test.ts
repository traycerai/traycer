import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostUpdateBoundDispatchRequestSchema as hostBarrelRequestSchema,
} from "@traycer/protocol/host/index";
import {
  hostUpdateActivateV11 as publicActivateV11,
  hostUpdateBoundDispatchExpectedIdentitySchema as publicIdentitySchema,
  hostUpdateBoundDispatchRequestSchema as publicRequestSchema,
  hostUpdateContinueV11 as publicContinueV11,
} from "@traycer/protocol/host/maintenance/index";
import type { HostUpdateBoundDispatchExpectedIdentity } from "@traycer/protocol/host/maintenance/index";
import {
  hostUpdateActivateUpgradeV10ToV11,
  hostUpdateActivateV10,
  hostUpdateActivateV11,
  hostUpdateContinueUpgradeV10ToV11,
  hostUpdateContinueV10,
  hostUpdateContinueV11,
} from "../contracts";
import {
  hostUpdateBoundDispatchExpectedIdentitySchema,
  hostUpdateBoundDispatchRequestSchema,
  hostUpdateBoundDispatchRequestSchemaPreExpectedIdentity,
  hostUpdateBoundDispatchResponseSchema,
} from "../schemas";

// The two BOUND update dispatches (D9/D16/D19): `host.update.activate` and
// `host.update.continue`, brand-new at 1.0, sharing one request and one
// response schema of their own - deliberately NOT `host.update.install`'s.

describe("hostUpdateBoundDispatchRequestSchema", () => {
  it("parses a non-empty attemptId and a boolean force", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.parse({
        attemptId: "attempt-1",
        force: true,
      }),
    ).toEqual({ attemptId: "attempt-1", force: true });
  });

  it("rejects an empty attemptId", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.safeParse({
        attemptId: "",
        force: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing force", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.safeParse({ attemptId: "attempt-1" })
        .success,
    ).toBe(false);
  });
});

describe("hostUpdateBoundDispatchResponseSchema", () => {
  it.each(["accepted", "already-updating"] as const)(
    "parses %s with a non-empty attemptId",
    (outcome) => {
      expect(
        hostUpdateBoundDispatchResponseSchema.parse({
          outcome,
          attemptId: "attempt-1",
        }),
      ).toEqual({ outcome, attemptId: "attempt-1" });
    },
  );

  it.each(["dispatch-indeterminate", "cli-failed"] as const)(
    // Unlike `host.update.install`'s `cli-failed`, which carries no reason at
    // all, a bound dispatch's `cli-failed` names why - most importantly "the
    // CLI is too old to honour these bound options."
    "parses %s with a non-empty reason",
    (outcome) => {
      expect(
        hostUpdateBoundDispatchResponseSchema.parse({
          outcome,
          reason: "cli-too-old",
        }),
      ).toEqual({ outcome, reason: "cli-too-old" });
    },
  );

  it("rejects an accepted arm with no attemptId, or with attemptId: null - every arm here is non-nullable, unlike host.update.install's legacy accommodation", () => {
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({ outcome: "accepted" })
        .success,
    ).toBe(false);
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({
        outcome: "accepted",
        attemptId: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a cli-failed arm with no reason", () => {
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({ outcome: "cli-failed" })
        .success,
    ).toBe(false);
  });

  it("rejects an outcome outside the declared set", () => {
    expect(
      hostUpdateBoundDispatchResponseSchema.safeParse({
        outcome: "declined",
        attemptId: "attempt-1",
      }).success,
    ).toBe(false);
  });
});

describe.each([
  [
    "host.update.activate",
    hostUpdateActivateV10,
    hostUpdateActivateV11,
    hostUpdateActivateUpgradeV10ToV11,
  ] as const,
  [
    "host.update.continue",
    hostUpdateContinueV10,
    hostUpdateContinueV11,
    hostUpdateContinueUpgradeV10ToV11,
  ] as const,
])("%s registry line", (method, v10, v11, upgrade) => {
  const REGISTRY = hostRpcRegistry[method];

  it("registers both minors of major 1, with the identity upgrade at 1.1", () => {
    expect(REGISTRY[1].latestMinor).toBe(1);
    expect(REGISTRY[1].versions[0].contract).toBe(v10);
    expect(REGISTRY[1].versions[0].upgradeFromPreviousVersion).toBeNull();
    expect(REGISTRY[1].versions[1].contract).toBe(v11);
    expect(REGISTRY[1].versions[1].upgradeFromPreviousVersion).toBe(upgrade);
  });

  it("adds no cross-major downgrade bridge", () => {
    expect(REGISTRY[1].downgradePathsFromLatest).toEqual({});
  });

  it("degrades as unsupported for a host that predates the method - a missing METHOD is refused at dispatch rather than silently dropping the bound intent onto a lower minor", () => {
    expect(REGISTRY.degrade).toEqual({ kind: "unsupported" });
  });

  // ROW 1. `@1.0` binds the FROZEN request shape, and that identity is the
  // whole mechanism: the dispatcher parses against the CALLER's schema, so a
  // released peer cannot see `expected` at all. Binding `@1.0` to the LIVE
  // schema instead would leave this method's shipped line growing every key a
  // later minor adds - which is the ablation, and it reddens this row.
  it("binds the FROZEN pre-`expected` request shape at 1.0 and the live one at 1.1", () => {
    expect(v10.requestSchema).toBe(
      hostUpdateBoundDispatchRequestSchemaPreExpectedIdentity,
    );
    expect(v11.requestSchema).toBe(hostUpdateBoundDispatchRequestSchema);
    // Same object on both, at both minors: the response never changed.
    expect(v10.responseSchema).toBe(hostUpdateBoundDispatchResponseSchema);
    expect(v11.responseSchema).toBe(hostUpdateBoundDispatchResponseSchema);
  });

  // ROW 1, from the parse rather than the wiring. The two assertions are not
  // redundant: `toBe` above proves which object is bound, this proves what
  // that binding DOES to a request carrying the key.
  it("strips `expected` structurally for a 1.0 peer, and keeps it at 1.1", () => {
    const sent = {
      attemptId: "attempt-1",
      force: false,
      expected: { generation: 4, sequence: 9 },
    };
    expect(v10.requestSchema.parse(sent)).toEqual({
      attemptId: "attempt-1",
      force: false,
    });
    expect(v11.requestSchema.parse(sent)).toEqual(sent);
  });

  // ROW 4's protocol half. "Optional" is a type fact until something parses a
  // request WITHOUT the key and shows it stays absent rather than defaulted -
  // absence is the legacy signal the host branches on, and a default would
  // erase the difference between "did not say" and "any position will do".
  it("parses a 1.1 request WITHOUT `expected`, leaving the key absent rather than defaulted", () => {
    const parsed = v11.requestSchema.parse({
      attemptId: "attempt-1",
      force: true,
    });
    expect(parsed).toEqual({ attemptId: "attempt-1", force: true });
    expect("expected" in parsed).toBe(false);
  });

  it("upgrades a 1.0 request to 1.1 without inventing an `expected` an old client never observed", () => {
    expect(upgrade.from).toEqual({ major: 1, minor: 0 });
    expect(upgrade.to).toEqual({ major: 1, minor: 1 });
    const upgraded = upgrade.upgradeRequest({
      attemptId: "attempt-1",
      force: false,
    });
    expect(upgraded).toEqual({ attemptId: "attempt-1", force: false });
    expect("expected" in upgraded).toBe(false);
  });
});

// The key itself. Its rule is the record decoder's `positiveInteger` and
// `host.status`'s sibling fields, not a looser wire-only one: these values are
// compared for EQUALITY against counters that arrived over that route, so a
// value either of them would reject can only ever produce a refusal.
describe("hostUpdateBoundDispatchRequestSchema — `expected`", () => {
  const base = { attemptId: "attempt-1", force: false };

  it("parses a well-formed observed identity", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.parse({
        ...base,
        expected: { generation: 1, sequence: 1 },
      }),
    ).toEqual({ ...base, expected: { generation: 1, sequence: 1 } });
  });

  it.each([
    ["a zero generation", { generation: 0, sequence: 1 }],
    ["a negative sequence", { generation: 1, sequence: -1 }],
    ["a fractional generation", { generation: 1.5, sequence: 1 }],
    ["a counter past the safe range", { generation: 1, sequence: 2 ** 53 + 1 }],
    ["a missing sequence", { generation: 1 }],
    ["a string generation", { generation: "1", sequence: 1 }],
  ])("rejects %s", (_what, expected) => {
    expect(
      hostUpdateBoundDispatchRequestSchema.safeParse({ ...base, expected })
        .success,
    ).toBe(false);
  });

  it("rejects a null `expected` - absent is how a caller declines to say, not null", () => {
    expect(
      hostUpdateBoundDispatchRequestSchema.safeParse({
        ...base,
        expected: null,
      }).success,
    ).toBe(false);
  });
});

// The barrel. Every other maintenance name reaches a client through
// `@traycer/protocol/host/maintenance/index` (and `../index` re-exports that
// wholesale as `@traycer/protocol/host`); the bound dispatch surface was the
// one part of `./contracts` and `./schemas` it did not carry, so `expected`
// was unreachable from the entrypoint its consumers already import.
describe("the maintenance barrel", () => {
  it("serves the bound dispatch surface from the entrypoint clients import", () => {
    // Deliberately the barrel, not `../schemas`: the deep path never broke,
    // so pinning it would pin the wrong thing.
    expect(publicRequestSchema).toBe(hostUpdateBoundDispatchRequestSchema);
    expect(publicIdentitySchema).toBe(
      hostUpdateBoundDispatchExpectedIdentitySchema,
    );
    expect(publicActivateV11).toBe(hostUpdateActivateV11);
    expect(publicContinueV11).toBe(hostUpdateContinueV11);

    // And one hop further out, through `../index`'s `export *`. Worth its own
    // assertion because that hop fails SILENTLY: a star re-export drops a name
    // that collides with another module's rather than erroring, so the two
    // entrypoints can disagree without anything here failing to compile.
    expect(hostBarrelRequestSchema).toBe(hostUpdateBoundDispatchRequestSchema);

    // The TYPE too, whose absence sent a consumer to the
    // `HostUpdateBoundDispatchRequest["expected"]` workaround. Only `compile`
    // reads this annotation - which is the point, since the missing name
    // failed at build time and never at run time.
    const identity: HostUpdateBoundDispatchExpectedIdentity = {
      generation: 1,
      sequence: 1,
    };
    expect(publicIdentitySchema.parse(identity)).toEqual(identity);
  });

  // The invariant the barrel's own comment states. Held mechanically because
  // the failure mode is silent: a name added to `./schemas` and not here is a
  // working deep import and a build error for everyone on the public path,
  // and nothing in the package notices until a consumer does.
  it("re-exports every export of `./contracts` and `./schemas`", () => {
    const read = (name: string): string =>
      readFileSync(
        fileURLToPath(new URL(`../${name}`, import.meta.url)),
        "utf8",
      );
    const barrel = read("index.ts");

    for (const module of ["contracts", "schemas"] as const) {
      const block = new RegExp(
        String.raw`export \{([^}]*)\} from "\./${module}";`,
      ).exec(barrel);
      expect(block, `no re-export block for ./${module}`).not.toBeNull();
      const reExported = new Set(
        (block?.[1] ?? "")
          .split(",")
          .map((entry) => entry.replace(/\btype\b/, "").trim())
          .filter((entry) => entry.length > 0),
      );

      // Broader than the declaration forms these files use today, so a later
      // `export interface` is counted rather than quietly exempted.
      const declared = [
        ...read(`${module}.ts`).matchAll(
          /^export (?:declare )?(?:abstract )?(?:const|let|function|type|interface|enum|class) ([A-Za-z0-9_$]+)/gm,
        ),
      ].map((match) => match[1]);

      expect(declared.length).toBeGreaterThan(0);
      expect(
        declared.filter((name) => !reExported.has(name)),
        `./${module} exports these, the barrel does not`,
      ).toEqual([]);
    }
  });
});
