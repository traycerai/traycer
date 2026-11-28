import { describe, expect, it } from "vitest";
import { environmentSetupAttemptsResponseSchema } from "../environment-schemas";
import { environmentSetupAttemptsResponseSchema as releasedResponseSchema } from "./__fixtures__/desktop-v1.5.4-setup-attempt-schema";

const legacyAttempt = {
  attemptId: "attempt-1",
  scriptHash: "sha256:abc123",
  itemRevision: 5,
  trigger: "resume",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_004_100,
  exitStatus: 2,
  stageReached: "install",
  result: "failed",
};

describe("sandbox setup attempt metadata compatibility", () => {
  it("lets the released schema accept the legacy trigger and strip new details", () => {
    const current = environmentSetupAttemptsResponseSchema.parse({
      attempts: [
        {
          ...legacyAttempt,
          trigger: "change",
          sandboxSetup: { trigger: "approval", startNumber: 8 },
        },
      ],
    });
    const parsed = releasedResponseSchema.parse(current);

    expect(parsed).toEqual({
      attempts: [{ ...legacyAttempt, trigger: "change" }],
    });
  });

  it("lets the current schema accept a released attempt without new details", () => {
    expect(
      environmentSetupAttemptsResponseSchema.parse({
        attempts: [legacyAttempt],
      }),
    ).toEqual({ attempts: [legacyAttempt] });
  });
});
