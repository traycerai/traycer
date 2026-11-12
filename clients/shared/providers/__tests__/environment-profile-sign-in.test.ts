import { describe, expect, it } from "vitest";
import { hostRunsOwnSettings } from "../environment-profile-sign-in";

describe("hostRunsOwnSettings", () => {
  it.each([
    [
      "a team's computer, even with its planes local",
      { kind: "team", teamName: "Acme" },
      { records: "local", broker: "local", room: "local" },
      false,
    ],
    [
      "a computer with one plane still its own",
      { kind: "personal" },
      { records: "moved", broker: "local", room: "moved" },
      true,
    ],
    [
      "a computer with one plane that stopped sharing",
      { kind: "personal" },
      { records: "moved", broker: "moved", room: "stopped" },
      true,
    ],
    [
      "a computer whose planes are all shared",
      { kind: "personal" },
      { records: "moved", broker: "shared_unrecorded", room: "moved" },
      false,
    ],
  ] as const)("answers for %s", (_case, principal, planes, expected) => {
    expect(hostRunsOwnSettings({ principal, planes })).toBe(expected);
  });
});
