import { describe, expect, it } from "vitest";
import {
  HOST_SANDBOX_STATES,
  hostSandboxStateWord,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";

const EXPECTED_WORDS: Record<HostSandboxState, string> = {
  creating: "Creating",
  awake: "Awake",
  suspending: "Suspending",
  suspended: "Suspended",
  resuming: "Resuming",
  stopping: "Stopping",
  stopped: "Stopped",
  starting: "Starting",
  destroying: "Destroying",
  destroyed: "Destroyed",
  failed: "Failed",
  released: "Not running",
};

describe("host sandbox state words", () => {
  it.each(HOST_SANDBOX_STATES)("returns the word for %s", (state) => {
    expect(hostSandboxStateWord(state)).toBe(EXPECTED_WORDS[state]);
  });

  it("returns Status unknown when the state is null", () => {
    expect(hostSandboxStateWord(null)).toBe("Status unknown");
  });
});
