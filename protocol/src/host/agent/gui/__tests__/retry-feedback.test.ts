import { describe, expect, it } from "vitest";
import {
  RETRY_ENDED_ERROR_CODE,
  RETRY_IN_PROGRESS_ERROR_CODE,
  RETRY_RECOVERED_ERROR_CODE,
  codexRetryTitle,
  codexRetryVisibility,
  isNonTerminalRetryErrorEvent,
  isRetryFeedbackCode,
} from "../retry-feedback";
import {
  runtimeEventSchema,
  runtimeEventSchemaPreFallback,
} from "../agent-runtime";

describe("retry feedback protocol helpers", () => {
  it("recognizes all lifecycle codes without treating auth recovery as retry feedback", () => {
    expect(isRetryFeedbackCode(RETRY_IN_PROGRESS_ERROR_CODE)).toBe(true);
    expect(isRetryFeedbackCode(RETRY_RECOVERED_ERROR_CODE)).toBe(true);
    expect(isRetryFeedbackCode(RETRY_ENDED_ERROR_CODE)).toBe(true);
    expect(isRetryFeedbackCode("auth")).toBe(false);
    expect(isRetryFeedbackCode(undefined)).toBe(false);

    expect(
      isNonTerminalRetryErrorEvent({
        type: "error",
        blockId: "retry-1",
        timestamp: 1,
        message: "retrying",
        recoverable: true,
        code: RETRY_ENDED_ERROR_CODE,
      }),
    ).toBe(true);
    expect(
      isNonTerminalRetryErrorEvent({
        type: "error",
        blockId: "auth-1",
        timestamp: 2,
        message: "signed out",
        recoverable: true,
        code: "auth",
      }),
    ).toBe(false);
  });

  it("only exposes active Codex retries while their turn is live", () => {
    expect(
      codexRetryVisibility("codex", RETRY_IN_PROGRESS_ERROR_CODE, false),
    ).toBe("active");
    expect(
      codexRetryVisibility("codex", RETRY_IN_PROGRESS_ERROR_CODE, true),
    ).toBe("hidden");
    expect(codexRetryVisibility("codex", RETRY_ENDED_ERROR_CODE, false)).toBe(
      "hidden",
    );
    expect(
      codexRetryVisibility("claude", RETRY_IN_PROGRESS_ERROR_CODE, false),
    ).toBeNull();
    expect(codexRetryVisibility("codex", "auth", false)).toBeNull();
  });

  it("uses generic retry copy unless a known reconnecting message is supplied", () => {
    expect(codexRetryTitle("Provider overloaded; retrying")).toBe(
      "Codex is retrying…",
    );
    expect(codexRetryTitle("Reconnecting… (attempt 2)")).toBe(
      "Codex is reconnecting…",
    );
    expect(codexRetryTitle("reconnecting now")).toBe("Codex is reconnecting…");
  });

  it.each([
    RETRY_IN_PROGRESS_ERROR_CODE,
    RETRY_RECOVERED_ERROR_CODE,
    RETRY_ENDED_ERROR_CODE,
  ])("decodes %s on both current and frozen runtime schemas", (code) => {
    const event = {
      type: "error" as const,
      blockId: "retry-wire-1",
      timestamp: 10,
      message: "Provider overloaded; retrying",
      recoverable: true,
      code,
    };

    expect(runtimeEventSchema.parse(event)).toMatchObject({
      type: "error",
      code,
    });
    expect(runtimeEventSchemaPreFallback.parse(event)).toMatchObject({
      type: "error",
      code,
    });
  });
});
