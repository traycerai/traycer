import { describe, expect, it } from "vitest";
import type {
  EnvironmentSecretsRotationResponse,
  RotationProducer,
} from "@traycer/protocol/host/environment-schemas";
import type { SandboxGrantRotation } from "@traycer/protocol/host/sandbox-secrets";
import {
  grantRotationLine,
  secretRotationStatus,
} from "@/lib/sandboxes/secret-rotation-line";

// `secret-rotation-line.test.ts` pins the lines a state and its proof produce
// together; this file pins the two halves ALONE: the state without the proof
// ("enforced" is never said before the host says so), and the proof without the
// state (a producer's line names a proof only when the evidence proves
// something).

const ACCEPTED = "New value accepted, closing old sessions.";

const PROVEN_CLASSES: SandboxGrantRotation["classes"] = [
  {
    workerClass: "postgres",
    status: "acknowledged",
    evidence: [{ kind: "session_closed", count: 3 }],
  },
  { workerClass: "https", status: "contained_by_expiry", evidence: null },
];

describe("grantRotationLine before the host says enforced", () => {
  it.each([
    "accepted",
    "enforcing",
    "stalled",
    "a_state_newer_than_this_build",
  ])(
    "reads accepted in state %s even when every class has proved the old value out of use",
    (state) => {
      const line = grantRotationLine({ state, classes: PROVEN_CLASSES });

      expect(line).toEqual({ tone: "muted", text: ACCEPTED });
    },
  );

  it.each(["accepted", "enforcing"])(
    "does not say the new value is in use in state %s with no class listed yet",
    (state) => {
      const line = grantRotationLine({ state, classes: [] });

      expect(line).toEqual({ tone: "muted", text: ACCEPTED });
    },
  );

  it("says enforced once the state is enforced and every class has proved it", () => {
    const line = grantRotationLine({
      state: "enforced",
      classes: PROVEN_CLASSES,
    });

    expect(line).toEqual({
      tone: "success",
      text: "New value enforced: postgres, 3 sessions closed; https, contained by expiry.",
    });
  });
});

function rotationWith(
  producers: RotationProducer[],
): NonNullable<EnvironmentSecretsRotationResponse["rotation"]> {
  return {
    rotationId: "rot-1",
    fromVersionId: "ver-1",
    toVersionId: "ver-2",
    state: "enforcing",
    issuedAt: 1_791_000_000_000,
    producers,
  };
}

function producerLines(producers: RotationProducer[]): readonly string[] {
  const status = secretRotationStatus(
    rotationWith(producers),
    (hostId) => `host ${hostId}`,
  );
  return (status?.producers ?? []).map((line) => line.text);
}

type Evidence = RotationProducer["evidence"];

// The Secrets page's wire closes the evidence kinds, so a kind newer than this
// build cannot arrive here (the grant and notification wires leave it open).
const NO_PROOF: ReadonlyArray<readonly [string, Evidence]> = [
  ["an empty receipt", []],
  ["a receipt with no evidence", null],
  ["a session_closed that closed none", [{ kind: "session_closed", count: 0 }]],
  ["a session_closed with no count", [{ kind: "session_closed", count: null }]],
];

describe("a producer's line names a proof only when the evidence proves something", () => {
  it.each(NO_PROOF)(
    "reads not confirmed yet for an acknowledged worker with %s",
    (_, evidence) => {
      expect(
        producerLines([
          {
            producer: "worker",
            workerClass: "https",
            incarnation: "inc-1",
            status: "acknowledged",
            evidence,
          },
        ]),
      ).toEqual(["https: not confirmed yet"]);
    },
  );

  it.each(NO_PROOF)(
    "reads not confirmed yet for an acknowledged host with %s",
    (_, evidence) => {
      expect(
        producerLines([
          {
            producer: "host",
            hostId: "h1",
            incarnation: "proc-1",
            status: "acknowledged",
            evidence,
          },
        ]),
      ).toEqual(["not confirmed yet on host h1"]);
    },
  );
});
