import { describe, expect, it } from "vitest";
import {
  RPC_ERROR_CODES,
  isRpcErrorCode,
} from "@traycer/protocol/framework/index";
import {
  epicShareRefusalErrorCode,
  epicShareRefusalFromErrorCode,
  epicShareRefusalSchema,
  epicSharePromotionPendingReasonSchema,
  isEpicShareRefusalErrorCode,
  type EpicShareRefusal,
} from "@traycer/protocol/host/epic/share-refusal";

/**
 * The share-refusal taxonomy (`s5-share-error-taxonomy`) is only worth minting
 * codes for if the union and the codes stay in bijection: a refusal whose code
 * no client can decode is the message-prefix problem with extra steps.
 */
const everyRefusal: readonly EpicShareRefusal[] = [
  { kind: "needs-cloud-sync" },
  { kind: "not-owned" },
  { kind: "refused" },
  ...epicSharePromotionPendingReasonSchema.options.map(
    (reason): EpicShareRefusal => ({ kind: "promotion-pending", reason }),
  ),
];

describe("epic share refusal union <-> wire codes", () => {
  it("round-trips every member of the union through its code", () => {
    for (const refusal of everyRefusal) {
      const code = epicShareRefusalErrorCode(refusal);
      expect(epicShareRefusalFromErrorCode(code), code).toEqual(refusal);
    }
  });

  it("assigns a distinct, registered code to every member", () => {
    const codes = everyRefusal.map(epicShareRefusalErrorCode);
    expect(new Set(codes).size).toBe(everyRefusal.length);
    for (const code of codes) {
      expect(isRpcErrorCode(code), code).toBe(true);
      expect(isEpicShareRefusalErrorCode(code), code).toBe(true);
    }
  });

  it("carries the pending reason on the wire rather than in prose", () => {
    const codes = epicSharePromotionPendingReasonSchema.options.map((reason) =>
      epicShareRefusalErrorCode({ kind: "promotion-pending", reason }),
    );
    expect(new Set(codes).size).toBe(
      epicSharePromotionPendingReasonSchema.options.length,
    );
  });

  it("reads a non-share code as `null` instead of inventing a refusal", () => {
    for (const code of ["RPC_ERROR", "FORBIDDEN", "WORKTREE_BUSY", "NOPE"]) {
      expect(epicShareRefusalFromErrorCode(code), code).toBeNull();
      expect(isEpicShareRefusalErrorCode(code), code).toBe(false);
    }
  });

  it("leaves no registered E_SHARE_* code undecodable", () => {
    for (const code of RPC_ERROR_CODES) {
      if (!code.startsWith("E_SHARE_")) continue;
      expect(epicShareRefusalFromErrorCode(code), code).not.toBeNull();
    }
  });

  it("parses the union off the wire", () => {
    expect(
      epicShareRefusalSchema.parse({
        kind: "promotion-pending",
        reason: "offline",
      }),
    ).toEqual({ kind: "promotion-pending", reason: "offline" });
    expect(
      epicShareRefusalSchema.safeParse({ kind: "promotion-pending" }).success,
    ).toBe(false);
  });
});
