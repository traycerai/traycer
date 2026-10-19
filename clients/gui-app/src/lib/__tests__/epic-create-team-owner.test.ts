import { describe, expect, it } from "vitest";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  EPIC_CREATE_TEAM_OWNER_MINOR,
  TEAM_CREATE_HOST_TOO_OLD,
  epicCreateFloor,
  teamCreateForbiddenLine,
  teamCreateRejectionMessage,
} from "@/lib/epic-create-admission";

/**
 * Team create admission: the floor a team create pays before any frame, and
 * what a rejected team create says.
 */

const HOST_TOO_OLD =
  "This host can't create team tasks yet. Update the host, or choose Personal.";

function floorRefusal(minor: number): HostMethodVersionUnsatisfiedError {
  return new HostMethodVersionUnsatisfiedError({
    requirement: { method: "epic.create", version: { major: 1, minor } },
    negotiated: { major: 1, minor: 2 },
    requestId: "r",
    method: "epic.create",
    hostId: "h",
  });
}

function rpcError(
  code: "FORBIDDEN" | "RPC_ERROR",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "r",
    method: "epic.create",
    fatalDetails: null,
  });
}

describe("team create constants", () => {
  it("carries the team owner from epic.create 1.3", () => {
    expect(EPIC_CREATE_TEAM_OWNER_MINOR).toBe(3);
  });

  it("states the too-old host line word for word", () => {
    expect(TEAM_CREATE_HOST_TOO_OLD).toBe(HOST_TOO_OLD);
  });

  it("states the forbidden line with a straight apostrophe and the slug", () => {
    expect(teamCreateForbiddenLine("acme")).toBe(
      "You're not a member of acme.",
    );
    expect(teamCreateForbiddenLine("platform-crew")).toBe(
      "You're not a member of platform-crew.",
    );
  });
});

describe("epicCreateFloor", () => {
  it("floors a team create at epic.create 1.3 whether or not signed in", () => {
    const expected = {
      method: "epic.create",
      version: { major: 1, minor: 3 },
    };
    expect(
      epicCreateFloor({
        owner: { kind: "team", teamId: "t1" },
        cloudAuthorized: true,
      }),
    ).toEqual(expected);
    expect(
      epicCreateFloor({
        owner: { kind: "team", teamId: "t1" },
        cloudAuthorized: false,
      }),
    ).toEqual(expected);
  });

  it("asks nothing of a signed-in Personal create", () => {
    expect(epicCreateFloor({ owner: null, cloudAuthorized: true })).toBeNull();
    expect(
      epicCreateFloor({ owner: { kind: "person" }, cloudAuthorized: true }),
    ).toBeNull();
  });

  it("keeps the local-first floor for a Personal create with no cloud verdict", () => {
    expect(epicCreateFloor({ owner: null, cloudAuthorized: false })).toEqual({
      method: "epic.create",
      version: { major: 1, minor: 1 },
    });
  });
});

describe("teamCreateRejectionMessage", () => {
  it("says the host is too old for the transport's epic.create 1.3 floor refusal", () => {
    expect(teamCreateRejectionMessage(floorRefusal(3), "acme")).toBe(
      HOST_TOO_OLD,
    );
  });

  it("leaves a floor refusal below 1.3 to the generic toast", () => {
    expect(teamCreateRejectionMessage(floorRefusal(1), "acme")).toBeNull();
  });

  it("names the team for FORBIDDEN, keyed on the code and not the message", () => {
    expect(
      teamCreateRejectionMessage(rpcError("FORBIDDEN", "Forbidden"), "acme"),
    ).toBe("You're not a member of acme.");
    expect(
      teamCreateRejectionMessage(
        rpcError("FORBIDDEN", "Something else went wrong upstream"),
        "acme",
      ),
    ).toBe("You're not a member of acme.");
  });

  it("leaves FORBIDDEN to the generic toast when no team is named", () => {
    expect(
      teamCreateRejectionMessage(rpcError("FORBIDDEN", "Forbidden"), null),
    ).toBeNull();
  });

  it("leaves other host errors to the generic toast", () => {
    expect(
      teamCreateRejectionMessage(rpcError("RPC_ERROR", "Forbidden"), "acme"),
    ).toBeNull();
  });

  it("leaves a plain Error to the generic toast", () => {
    expect(
      teamCreateRejectionMessage(new Error("You are forbidden"), "acme"),
    ).toBeNull();
  });
});
