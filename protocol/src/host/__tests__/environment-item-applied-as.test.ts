import { describe, expect, it } from "vitest";
import {
  environmentItemStatusSchema,
  environmentStatusResponseSchema,
} from "@traycer/protocol/host/environment-schemas";

/**
 * `EnvironmentItemStatus.appliedAs`: the native
 * entry the host wrote an `mcp_server` or `skill` item as. The field is
 * required and nullable, and its `entryKind` is a closed set.
 */

interface AppliedAsFixture {
  entryKind: string;
  name: string;
  userId?: string;
}

interface ItemFixtureInput {
  kind: string;
  key: string;
  appliedAs: AppliedAsFixture | null;
}

function itemFixture(input: ItemFixtureInput) {
  return {
    kind: input.kind,
    key: input.key,
    os: "any",
    desiredRevision: 4,
    status: "applied",
    code: "ok",
    args: { exitStatus: null, stage: null, durationMs: 120, kind: null },
    brokerEnforced: null,
    minimumHostVersion: null,
    appliedAs: input.appliedAs,
  };
}

describe("environmentItemStatusSchema appliedAs", () => {
  it("parses a full item with appliedAs null, an mcp entry and a skills entry", () => {
    const nullCase = environmentItemStatusSchema.safeParse(
      itemFixture({ kind: "variable", key: "EDITOR", appliedAs: null }),
    );
    expect(nullCase.success).toBe(true);
    if (nullCase.success) {
      expect(nullCase.data.appliedAs).toBeNull();
    }

    const mcpCase = environmentItemStatusSchema.safeParse(
      itemFixture({
        kind: "mcp_server",
        key: "mcp:github",
        appliedAs: { entryKind: "mcp", name: "github" },
      }),
    );
    expect(mcpCase.success).toBe(true);
    if (mcpCase.success) {
      expect(mcpCase.data.appliedAs).toEqual({
        entryKind: "mcp",
        name: "github",
      });
    }

    const skillsCase = environmentItemStatusSchema.safeParse(
      itemFixture({
        kind: "skill",
        key: "skill:3f2a9c",
        appliedAs: { entryKind: "skills", name: "pdf" },
      }),
    );
    expect(skillsCase.success).toBe(true);
    if (skillsCase.success) {
      expect(skillsCase.data.appliedAs).toEqual({
        entryKind: "skills",
        name: "pdf",
      });
    }
  });

  it("rejects an item with appliedAs missing", () => {
    const { appliedAs: _omitted, ...withoutAppliedAs } = itemFixture({
      kind: "mcp_server",
      key: "mcp:github",
      appliedAs: null,
    });
    expect(
      environmentItemStatusSchema.safeParse(withoutAppliedAs).success,
    ).toBe(false);
  });

  it("rejects an entryKind outside mcp and skills", () => {
    const result = environmentItemStatusSchema.safeParse(
      itemFixture({
        kind: "skill",
        key: "skill:3f2a9c",
        appliedAs: { entryKind: "plugins", name: "pdf" },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an empty appliedAs name", () => {
    const result = environmentItemStatusSchema.safeParse(
      itemFixture({
        kind: "mcp_server",
        key: "mcp:github",
        appliedAs: { entryKind: "mcp", name: "" },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("strips an extra key inside appliedAs", () => {
    const result = environmentItemStatusSchema.safeParse(
      itemFixture({
        kind: "mcp_server",
        key: "mcp:github",
        appliedAs: { entryKind: "mcp", name: "github", userId: "user-1" },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appliedAs).toEqual({
        entryKind: "mcp",
        name: "github",
      });
      expect(Object.keys(result.data.appliedAs ?? {})).toEqual([
        "entryKind",
        "name",
      ]);
    }
  });
});

/**
 * `EnvironmentItemStatus.args.kind`: which case of
 * a code the client words differently. Open, and absent from a host that
 * predates it.
 */
describe("environmentItemStatusSchema args.kind", () => {
  function itemWithArgs(args: Record<string, unknown>) {
    return {
      ...itemFixture({ kind: "mcp_server", key: "gh", appliedAs: null }),
      args,
    };
  }

  it("parses an item whose args lack kind, as null", () => {
    const result = environmentItemStatusSchema.safeParse(
      itemWithArgs({ exitStatus: null, stage: null, durationMs: 120 }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args.kind).toBeNull();
    }
  });

  it("keeps the kind a host names", () => {
    const result = environmentItemStatusSchema.safeParse(
      itemWithArgs({
        exitStatus: null,
        stage: null,
        durationMs: null,
        kind: "headers_in_sandbox",
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args.kind).toBe("headers_in_sandbox");
    }
  });

  it("keeps a kind a newer host names, and refuses an empty or overlong one", () => {
    const args = { exitStatus: null, stage: null, durationMs: null };
    const newer = environmentItemStatusSchema.safeParse(
      itemWithArgs({ ...args, kind: "from_a_newer_host" }),
    );
    expect(newer.success).toBe(true);
    expect(
      environmentItemStatusSchema.safeParse(itemWithArgs({ ...args, kind: "" }))
        .success,
    ).toBe(false);
    expect(
      environmentItemStatusSchema.safeParse(
        itemWithArgs({ ...args, kind: "k".repeat(65) }),
      ).success,
    ).toBe(false);
  });
});

describe("environmentStatusResponseSchema items carry appliedAs", () => {
  it("parses a response holding an mcp_server item with appliedAs and a variable item with null", () => {
    const response = {
      principal: { kind: "personal" },
      reachability: "connected",
      bindingGeneration: 3,
      desiredRevision: 12,
      receivedRevision: 12,
      appliedRevision: 12,
      receiptAgeMs: 2500,
      items: [
        itemFixture({
          kind: "mcp_server",
          key: "mcp:github",
          appliedAs: { entryKind: "mcp", name: "github" },
        }),
        itemFixture({ kind: "variable", key: "EDITOR", appliedAs: null }),
      ],
      pendingUploads: [],
      setup: { stage: "done", state: "done" },
      remoteAccess: "on",
    };

    const result = environmentStatusResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items.map((item) => item.appliedAs)).toEqual([
        { entryKind: "mcp", name: "github" },
        null,
      ]);
    }
  });
});
