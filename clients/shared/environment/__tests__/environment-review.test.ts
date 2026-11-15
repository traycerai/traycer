import { afterEach, describe, expect, it, vi } from "vitest";
import { undoNotice } from "../environment-review";
import { createEnvironmentCloud } from "./environment-cloud-test-support";

const NOTICE_ID = JSON.stringify([7, "variable", "API_KEY", null]);

afterEach(() => {
  vi.restoreAllMocks();
});

function refuseUndo(body: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("notice Undo permission mapping", () => {
  it("reports a host grant requirement only for its authn code", async () => {
    refuseUndo(JSON.stringify({ code: "executable_write_needs_grant" }));

    await expect(
      undoNotice(createEnvironmentCloud("test-bearer"), "team-a", NOTICE_ID),
    ).resolves.toEqual({ outcome: "needs_grant" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://authn.example.test/api/v3/environments/team-a/changes/7/undo",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "variable", key: "API_KEY", os: null }),
      }),
    );
  });

  it("reports the existing permission refusal for any other 403 code", async () => {
    refuseUndo(JSON.stringify({ code: "role_forbidden" }));

    await expect(
      undoNotice(createEnvironmentCloud("test-bearer"), "team-a", NOTICE_ID),
    ).rejects.toMatchObject({
      kind: "forbidden",
      message: "This change needs permission.",
    });
  });

  it("reports the existing permission refusal when a 403 body is not parseable", async () => {
    refuseUndo("not json");

    await expect(
      undoNotice(createEnvironmentCloud("test-bearer"), "team-a", NOTICE_ID),
    ).rejects.toMatchObject({
      kind: "forbidden",
      message: "This change needs permission.",
    });
  });

  it("reports a superseded notice as stale with its current revision", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "superseded",
          current: {
            kind: "variable",
            key: "API_KEY",
            os: null,
            value: { value: "new" },
            revision: 8,
            updatedAt: 12,
            writtenBy: {
              source: "dashboard",
              hostId: null,
              hostName: null,
            },
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      undoNotice(createEnvironmentCloud("test-bearer"), "team-a", NOTICE_ID),
    ).resolves.toEqual({
      outcome: "stale",
      currentRevision: 8,
      changedBy: { kind: "dashboard" },
    });
  });

  it("reports a notice that cannot be restored as no longer available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: "nothing_displaced", current: null }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      undoNotice(createEnvironmentCloud("test-bearer"), "team-a", NOTICE_ID),
    ).rejects.toMatchObject({
      kind: "refused",
      message: "This notice is no longer available.",
    });
  });
});
