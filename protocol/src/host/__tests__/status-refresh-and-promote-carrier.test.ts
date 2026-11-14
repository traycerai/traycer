import { describe, expect, it } from "vitest";
import { hostStatusRefreshV10 } from "@traycer/protocol/host/environment-contracts";
import {
  providersNativeMutateUpgradeV14ToV15,
  providersNativeMutateV14,
  providersNativeMutateV15,
} from "@traycer/protocol/host/registry";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

const promoteMutationV14 = {
  kind: "promoteToPersonal" as const,
  entryKind: "mcp" as const,
  scope: "global" as const,
  workspaceRoot: null,
  name: "docs",
};

const promoteRequestV14 = {
  providerId: "claude-code" as const,
  mutation: promoteMutationV14,
  executableWriteGrant: null,
  expectedEnvironmentId: null,
};

const promoteOnlyErrorCodes = [
  "needs_connection",
  "upload_refused",
  "needs_grant",
  "environment_not_served",
  "not_global_scope",
  "bound_to_this_computer",
  "invalid_entry",
] as const;

describe("dormant status refresh and promote carrier contracts", () => {
  it("keeps host.status.refresh@1.0 empty in both directions", () => {
    expect(hostStatusRefreshV10.requestSchema.parse({})).toEqual({});
    expect(() =>
      hostStatusRefreshV10.requestSchema.parse({ extra: true }),
    ).toThrow();
    expect(hostStatusRefreshV10.responseSchema.parse({})).toEqual({});
    expect(() =>
      hostStatusRefreshV10.responseSchema.parse({ state: "on" }),
    ).toThrow();
  });

  it("validates and defaults the promote intent on the v1.5 arm", () => {
    const withIntent = providersNativeMutateV15.requestSchema.parse({
      ...promoteRequestV14,
      mutation: { ...promoteMutationV14, intentOperationId: UUID },
    });
    expect(withIntent.mutation).toEqual({
      ...promoteMutationV14,
      intentOperationId: UUID,
    });

    expect(
      providersNativeMutateV15.requestSchema.parse({
        ...promoteRequestV14,
        mutation: { ...promoteMutationV14, intentOperationId: null },
      }).mutation,
    ).toEqual({ ...promoteMutationV14, intentOperationId: null });
    expect(
      providersNativeMutateV15.requestSchema.parse(promoteRequestV14).mutation,
    ).toEqual({ ...promoteMutationV14, intentOperationId: null });
    expect(() =>
      providersNativeMutateV15.requestSchema.parse({
        ...promoteRequestV14,
        mutation: {
          ...promoteMutationV14,
          intentOperationId: "not-a-uuid",
        },
      }),
    ).toThrow();
    expect(() =>
      providersNativeMutateV15.requestSchema.parse({
        ...promoteRequestV14,
        mutation: {
          ...promoteMutationV14,
          scope: "project",
          workspaceRoot: null,
          intentOperationId: UUID,
        },
      }),
    ).toThrow();
  });

  it("upgrades only the promote arm with a null intent", () => {
    const promote =
      providersNativeMutateV14.requestSchema.parse(promoteRequestV14);
    const promoted =
      providersNativeMutateUpgradeV14ToV15.upgradeRequest(promote);
    expect(promoted).toEqual({
      ...promote,
      mutation: { ...promote.mutation, intentOperationId: null },
    });
    expect(providersNativeMutateV15.requestSchema.parse(promoted)).toEqual(
      promoted,
    );

    const removeRequest = {
      providerId: "claude-code" as const,
      mutation: {
        kind: "mcp" as const,
        scope: "global" as const,
        workspaceRoot: null,
        mutation: { action: "remove" as const, name: "docs" },
      },
      executableWriteGrant: null,
      expectedEnvironmentId: null,
    };
    const remove = providersNativeMutateV14.requestSchema.parse(removeRequest);
    expect(providersNativeMutateUpgradeV14ToV15.upgradeRequest(remove)).toEqual(
      remove,
    );
  });

  it("keeps the v1.4 carrier shape and strips the v1.5 intent on downgrade parsing", () => {
    expect(
      providersNativeMutateV14.requestSchema.parse(promoteRequestV14),
    ).toEqual(promoteRequestV14);
    const current = providersNativeMutateV15.requestSchema.parse({
      ...promoteRequestV14,
      mutation: { ...promoteMutationV14, intentOperationId: UUID },
    });
    expect(providersNativeMutateV14.requestSchema.parse(current)).toEqual(
      promoteRequestV14,
    );
  });

  it("parses the seven promote-only refusals only on the v1.5 response", () => {
    for (const code of promoteOnlyErrorCodes) {
      const answer = { result: { ok: false as const, code, detail: null } };
      expect(providersNativeMutateV15.responseSchema.parse(answer)).toEqual(
        answer,
      );
      expect(() =>
        providersNativeMutateV14.responseSchema.parse(answer),
      ).toThrow();
    }
  });

  it("keeps v1.4 refusals and success responses in the v1.5 response", () => {
    for (const code of [
      "environment_mismatch",
      "server_not_found",
      "unsupported_action",
    ] as const) {
      const answer = { result: { ok: false as const, code, detail: null } };
      expect(providersNativeMutateV15.responseSchema.parse(answer)).toEqual(
        answer,
      );
    }
    const success = { result: { ok: true, kind: "plugins", plugins: [] } };
    expect(providersNativeMutateV15.responseSchema.parse(success)).toEqual(
      success,
    );
    expect(() =>
      providersNativeMutateV15.responseSchema.parse({
        result: { ok: false, code: "future_error", detail: null },
      }),
    ).toThrow();
  });
});
