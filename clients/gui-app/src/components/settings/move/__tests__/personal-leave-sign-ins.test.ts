import { describe, expect, it } from "vitest";
import type { EnvironmentMovePersonalProfile } from "@traycer/protocol/host/environment/move-contracts";
import {
  personalLeaveAddress,
  type PersonalLeaveAccountState,
  type PersonalLeaveAccountStates,
} from "../personal-leave-model";
import { personalLeaveSignIns } from "../use-personal-leave";

function row(
  profileId: string,
  signIn: EnvironmentMovePersonalProfile["signIn"],
  shared: boolean,
): EnvironmentMovePersonalProfile {
  return { providerId: "claude-code", profileId, label: profileId, signIn, shared };
}

function statesOf(
  entries: readonly (readonly [
    EnvironmentMovePersonalProfile,
    PersonalLeaveAccountState,
  ])[],
): PersonalLeaveAccountStates {
  return new Map(
    entries.map(([profile, state]) => [personalLeaveAddress(profile), state]),
  );
}

describe("personalLeaveSignIns", () => {
  const sharedRow = row("shared", "offered", true);
  const ownRow = row("own", "offered", false);
  const answeredRow = row("answered", "offered", true);
  const mismatchRow = row("mismatch", "offered", true);
  const unprovenRow = row("unproven", "offered", true);
  const keyRow = row("key", "not-needed", true);

  it("sends skip only for a row whose person pressed Skip, shared or not", () => {
    expect(
      personalLeaveSignIns(
        [sharedRow, ownRow],
        statesOf([
          [sharedRow, { kind: "skip" }],
          [ownRow, { kind: "skip" }],
        ]),
      ),
    ).toEqual([
      { providerId: "claude-code", profileId: "shared", signIn: { kind: "skip" } },
      { providerId: "claude-code", profileId: "own", signIn: { kind: "skip" } },
    ]);
  });

  it("sends untouched for an offered row with no state, shared or not", () => {
    expect(
      personalLeaveSignIns([sharedRow, ownRow], new Map()),
    ).toEqual([
      {
        providerId: "claude-code",
        profileId: "shared",
        signIn: { kind: "untouched" },
      },
      {
        providerId: "claude-code",
        profileId: "own",
        signIn: { kind: "untouched" },
      },
    ]);
  });

  it("sends untouched for a row left at account-mismatch or account-unproven, which the person did not skip", () => {
    expect(
      personalLeaveSignIns(
        [mismatchRow, unprovenRow],
        statesOf([
          [mismatchRow, { kind: "account-mismatch" }],
          [unprovenRow, { kind: "account-unproven" }],
        ]),
      ),
    ).toEqual([
      {
        providerId: "claude-code",
        profileId: "mismatch",
        signIn: { kind: "untouched" },
      },
      {
        providerId: "claude-code",
        profileId: "unproven",
        signIn: { kind: "untouched" },
      },
    ]);
  });

  it("sends the held handle for a signed-in row and leaves out a row that needs no sign-in", () => {
    expect(
      personalLeaveSignIns(
        [answeredRow, keyRow],
        statesOf([
          [answeredRow, { kind: "signed-in", admissionId: "held-admission" }],
          [keyRow, { kind: "skip" }],
        ]),
      ),
    ).toEqual([
      {
        providerId: "claude-code",
        profileId: "answered",
        signIn: { kind: "signed-in", admissionId: "held-admission" },
      },
    ]);
  });
});
