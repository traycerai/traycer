import { describe, expect, it } from "vitest";
import { isProfileLifecycleRejection } from "../profile-lifecycle-rejection";

const LIFECYCLE_MESSAGES = [
  'No profile "work-2" is registered for provider "codex".',
  'Profile "work-2" for provider "codex" was removed and can no longer be used.',
  'Profile "work-2" for provider "codex" is still completing setup and cannot be used yet.',
  'Provider "cursor" does not support managed profiles.',
];

describe("isProfileLifecycleRejection", () => {
  it.each(LIFECYCLE_MESSAGES)("accepts an RPC_ERROR carrying %s", (message) => {
    expect(isProfileLifecycleRejection("RPC_ERROR", message)).toBe(true);
  });

  it("accepts a template with text appended after its first sentence", () => {
    expect(
      isProfileLifecycleRejection(
        "RPC_ERROR",
        'Profile "work-2" for provider "codex" was removed and can no longer be used. If a worktree was already prepared, it has not been removed.',
      ),
    ).toBe(true);
  });

  it.each(LIFECYCLE_MESSAGES)(
    "rejects the same message under another code (%s)",
    (message) => {
      expect(isProfileLifecycleRejection("E_INVALID_ARGUMENT", message)).toBe(
        false,
      );
    },
  );

  it.each([
    "agent not found",
    "Invalid params for agent.sendMessage: profile: Required",
    'The reserved value "ambient" cannot be used as a managed profile id for provider "codex".',
    'wrapped: Profile "x" for provider "codex" was removed and can no longer be used.',
  ])("rejects an RPC_ERROR with another message (%s)", (message) => {
    expect(isProfileLifecycleRejection("RPC_ERROR", message)).toBe(false);
  });
});
