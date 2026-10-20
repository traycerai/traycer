import { describe, expect, it } from "vitest";
import type {
  EnvironmentSecretsRotationResponse,
  RotationProducer,
} from "@traycer/protocol/host/environment-schemas";
import type { SandboxGrantRotation } from "@traycer/protocol/host/sandbox-secrets";
import {
  grantRotationLine,
  rotationProofPhrase,
  rotationProven,
  secretRotationSettled,
  secretRotationStatus,
} from "@/lib/sandboxes/secret-rotation-line";

type Rotation = NonNullable<EnvironmentSecretsRotationResponse["rotation"]>;
type GrantClass = SandboxGrantRotation["classes"][number];

const ACCEPTED_TEXT = "New value accepted, closing old sessions.";
const HOST_ID = "host-1";

function hostName(hostId: string): string {
  return hostId === HOST_ID ? "dev-sandbox" : hostId;
}

function grantRotation(
  state: string,
  classes: readonly GrantClass[],
): SandboxGrantRotation {
  return { state, classes };
}

function grantClass(
  name: string,
  status: string,
  evidence: GrantClass["evidence"],
): GrantClass {
  return { workerClass: name, status, evidence };
}

function worker(
  overrides: Partial<Extract<RotationProducer, { producer: "worker" }>>,
): RotationProducer {
  return {
    producer: "worker",
    workerClass: "postgres",
    incarnation: "inc-1",
    status: "acknowledged",
    evidence: [{ kind: "session_closed", count: 3 }],
    ...overrides,
  };
}

function host(
  overrides: Partial<Extract<RotationProducer, { producer: "host" }>>,
): RotationProducer {
  return {
    producer: "host",
    hostId: HOST_ID,
    incarnation: "proc-1",
    status: "acknowledged",
    evidence: [{ kind: "session_closed", count: 3 }],
    ...overrides,
  };
}

function rotationOf(
  state: Rotation["state"],
  producers: RotationProducer[],
): Rotation {
  return {
    rotationId: "rot-1",
    fromVersionId: "v1",
    toVersionId: "v2",
    state,
    issuedAt: 1_791_000_000_000,
    producers,
  };
}

describe("rotationProofPhrase", () => {
  it("sums the session_closed counts and says one session in the singular", () => {
    expect(
      rotationProofPhrase([
        { kind: "session_closed", count: 2 },
        { kind: "session_closed", count: 1 },
      ]),
    ).toBe("3 sessions closed");
    expect(rotationProofPhrase([{ kind: "session_closed", count: 1 }])).toBe(
      "1 session closed",
    );
  });

  it("joins the proofs in the wire's order, whatever order they arrive in", () => {
    expect(
      rotationProofPhrase([
        { kind: "probe_refused", count: null },
        { kind: "cache_cleared", count: 4 },
        { kind: "session_closed", count: 2 },
      ]),
    ).toBe("2 sessions closed, cached keys dropped, old value refused");
  });

  it("ignores a kind this build has no word for", () => {
    expect(
      rotationProofPhrase([
        { kind: "from_a_newer_host", count: 9 },
        { kind: "session_closed", count: 1 },
      ]),
    ).toBe("1 session closed");
    expect(
      rotationProofPhrase([{ kind: "from_a_newer_host", count: 9 }]),
    ).toBeNull();
  });

  it("proves nothing from no evidence, a null count or a count of zero", () => {
    expect(rotationProofPhrase(null)).toBeNull();
    expect(rotationProofPhrase([])).toBeNull();
    expect(
      rotationProofPhrase([{ kind: "session_closed", count: null }]),
    ).toBeNull();
    expect(
      rotationProofPhrase([{ kind: "session_closed", count: 0 }]),
    ).toBeNull();
  });
});

describe("rotationProven", () => {
  it("owes nothing for a producer contained by expiry or applied on resume", () => {
    expect(
      rotationProven({ status: "contained_by_expiry", evidence: null }),
    ).toBe(true);
    expect(
      rotationProven({ status: "applies_on_resume", evidence: null }),
    ).toBe(true);
  });

  it("needs an acknowledged producer to carry a known proof", () => {
    expect(
      rotationProven({
        status: "acknowledged",
        evidence: [{ kind: "cache_cleared", count: 0 }],
      }),
    ).toBe(true);
    expect(
      rotationProven({
        status: "acknowledged",
        evidence: [{ kind: "probe_refused", count: null }],
      }),
    ).toBe(true);
    expect(rotationProven({ status: "acknowledged", evidence: [] })).toBe(
      false,
    );
    expect(rotationProven({ status: "acknowledged", evidence: null })).toBe(
      false,
    );
    expect(
      rotationProven({
        status: "acknowledged",
        evidence: [{ kind: "session_closed", count: 0 }],
      }),
    ).toBe(false);
  });

  it("never proves a missing producer, nor a status this build has no word for", () => {
    expect(
      rotationProven({
        status: "missing",
        evidence: [{ kind: "session_closed", count: 3 }],
      }),
    ).toBe(false);
    expect(
      rotationProven({
        status: "from_a_newer_host",
        evidence: [{ kind: "session_closed", count: 3 }],
      }),
    ).toBe(false);
  });
});

describe("grantRotationLine", () => {
  it("is null for a grant with no rotation", () => {
    expect(grantRotationLine(null)).toBeNull();
  });

  it("warns that the old value may still be in use when the rotation failed", () => {
    expect(grantRotationLine(grantRotation("failed", []))).toEqual({
      tone: "warning",
      text: "Replacing the value failed. The old value may still be in use.",
    });
  });

  it.each(["accepted", "enforcing", "stalled", "from_a_newer_broker"])(
    "reads accepted while the state is %s",
    (state) => {
      expect(
        grantRotationLine(
          grantRotation(state, [grantClass("postgres", "missing", null)]),
        ),
      ).toEqual({ tone: "muted", text: ACCEPTED_TEXT });
    },
  );

  it("names each class with its proof once every class has proved the old value out of use", () => {
    expect(
      grantRotationLine(
        grantRotation("enforced", [
          grantClass("postgres", "acknowledged", [
            { kind: "session_closed", count: 3 },
          ]),
          grantClass("https", "acknowledged", [
            { kind: "cache_cleared", count: 2 },
          ]),
        ]),
      ),
    ).toEqual({
      tone: "success",
      text: "New value enforced: postgres, 3 sessions closed; https, cached keys dropped.",
    });
  });

  it("says the new value is in use when no class owes an acknowledgement", () => {
    expect(grantRotationLine(grantRotation("enforced", []))).toEqual({
      tone: "success",
      text: "New value in use.",
    });
  });

  it.each([
    ["no evidence", []],
    ["null evidence", null],
    [
      "an evidence kind from a newer host",
      [{ kind: "from_a_newer_host", count: 4 }],
    ],
    ["a session_closed count of zero", [{ kind: "session_closed", count: 0 }]],
    [
      "a session_closed count of none",
      [{ kind: "session_closed", count: null }],
    ],
  ])(
    "does not read enforced for an acknowledged class that carries %s",
    (_label, evidence) => {
      expect(
        grantRotationLine(
          grantRotation("enforced", [
            grantClass("postgres", "acknowledged", evidence),
          ]),
        ),
      ).toEqual({ tone: "muted", text: ACCEPTED_TEXT });
    },
  );

  it("does not read enforced when one of two classes has proved nothing", () => {
    expect(
      grantRotationLine(
        grantRotation("enforced", [
          grantClass("postgres", "acknowledged", [
            { kind: "session_closed", count: 3 },
          ]),
          grantClass("https", "missing", null),
        ]),
      ),
    ).toEqual({ tone: "muted", text: ACCEPTED_TEXT });
  });

  it("counts a class contained by expiry as settled, in its own words", () => {
    expect(
      grantRotationLine(
        grantRotation("enforced", [
          grantClass("postgres", "contained_by_expiry", null),
        ]),
      ),
    ).toEqual({
      tone: "success",
      text: "New value enforced: postgres, contained by expiry.",
    });
  });

  // A replacement during an open session reads accepted, then enforced with
  // the class.
  it("reads accepted, then enforced with the class, as a replacement during an open session settles", () => {
    expect(
      grantRotationLine(
        grantRotation("accepted", [grantClass("postgres", "missing", null)]),
      ),
    ).toEqual({ tone: "muted", text: ACCEPTED_TEXT });

    expect(
      grantRotationLine(
        grantRotation("enforced", [
          grantClass("postgres", "acknowledged", [
            { kind: "session_closed", count: 1 },
          ]),
        ]),
      ),
    ).toEqual({
      tone: "success",
      text: "New value enforced: postgres, 1 session closed.",
    });
  });

  // The red-first defect: an acknowledged class counted as proven whatever its
  // evidence. The same assertion fails against a copy of the module with that
  // rule, and passes here.
  it("does not read enforced for a class that closed no session", () => {
    const line = grantRotationLine(
      grantRotation("enforced", [
        grantClass("postgres", "acknowledged", [
          { kind: "session_closed", count: 0 },
        ]),
      ]),
    );
    expect(line?.text).not.toContain("New value enforced");
    expect(line?.text).toBe(ACCEPTED_TEXT);
  });
});

describe("secretRotationStatus", () => {
  it("is null for a secret with no rotation", () => {
    expect(secretRotationStatus(null, hostName)).toBeNull();
  });

  it("warns on a failed rotation, with the producers it has", () => {
    const status = secretRotationStatus(
      rotationOf("failed", [worker({ status: "missing", evidence: null })]),
      hostName,
    );
    expect(status?.headline).toEqual({
      tone: "warning",
      text: "Replacing the value failed. The old value may still be in use.",
    });
    expect(status?.producers.map((line) => line.text)).toEqual([
      "postgres: not confirmed yet",
    ]);
  });

  it("says a stalled rotation was not confirmed after a minute, and how to end every old session", () => {
    expect(
      secretRotationStatus(rotationOf("stalled", []), hostName)?.headline,
    ).toEqual({
      tone: "warning",
      text: "Not confirmed after a minute. Stopping the sandbox ends every old session.",
    });
  });

  it.each(["accepted", "enforcing"] as const)(
    "reads accepted while the state is %s",
    (state) => {
      expect(
        secretRotationStatus(
          rotationOf(state, [worker({ status: "missing", evidence: null })]),
          hostName,
        )?.headline,
      ).toEqual({ tone: "muted", text: ACCEPTED_TEXT });
    },
  );

  it("reads enforced once every producer has proved the old value out of use", () => {
    const status = secretRotationStatus(
      rotationOf("enforced", [
        worker({}),
        host({ evidence: [{ kind: "cache_cleared", count: 1 }] }),
      ]),
      hostName,
    );
    expect(status?.headline).toEqual({
      tone: "success",
      text: "New value enforced.",
    });
  });

  it("reads enforced with no producer at all", () => {
    expect(
      secretRotationStatus(rotationOf("enforced", []), hostName)?.headline,
    ).toEqual({ tone: "success", text: "New value enforced." });
  });

  it("does not read enforced when one producer is still missing", () => {
    const status = secretRotationStatus(
      rotationOf("enforced", [
        worker({}),
        host({ status: "missing", evidence: null }),
      ]),
      hostName,
    );
    expect(status?.headline).toEqual({ tone: "muted", text: ACCEPTED_TEXT });
    expect(status?.producers.map((line) => line.text)).toEqual([
      "postgres: 3 sessions closed",
      "not confirmed yet on dev-sandbox",
    ]);
  });

  it("does not read enforced when a producer is acknowledged with a bare zero-count session_closed", () => {
    expect(
      secretRotationStatus(
        rotationOf("enforced", [
          worker({ evidence: [{ kind: "session_closed", count: 0 }] }),
        ]),
        hostName,
      )?.headline,
    ).toEqual({ tone: "muted", text: ACCEPTED_TEXT });
  });

  it("words a worker class's line by what it proved", () => {
    const status = secretRotationStatus(
      rotationOf("enforcing", [
        worker({}),
        worker({
          workerClass: "https",
          incarnation: "inc-2",
          status: "contained_by_expiry",
          evidence: null,
        }),
        worker({
          workerClass: "ssh",
          incarnation: "inc-3",
          status: "missing",
          evidence: null,
        }),
        worker({
          workerClass: "redis",
          incarnation: "inc-4",
          evidence: [
            { kind: "cache_cleared", count: 2 },
            { kind: "probe_refused", count: null },
          ],
        }),
      ]),
      hostName,
    );
    expect(status?.producers.map((line) => line.text)).toEqual([
      "postgres: 3 sessions closed",
      "https: contained by expiry",
      "ssh: not confirmed yet",
      "redis: cached keys dropped, old value refused",
    ]);
  });

  it("words a host's line with its name", () => {
    const status = secretRotationStatus(
      rotationOf("enforcing", [
        host({}),
        host({
          incarnation: null,
          status: "applies_on_resume",
          evidence: null,
        }),
        host({ status: "missing", evidence: null }),
      ]),
      hostName,
    );
    expect(status?.producers.map((line) => line.text)).toEqual([
      "3 sessions closed on dev-sandbox",
      "applies when dev-sandbox wakes",
      "not confirmed yet on dev-sandbox",
    ]);
  });

  it("gives each worker class and each host producer its own key", () => {
    const status = secretRotationStatus(
      rotationOf("enforcing", [
        worker({ incarnation: "inc-1" }),
        worker({ incarnation: "inc-2" }),
        worker({ workerClass: "https", incarnation: "inc-1" }),
        host({ incarnation: "proc-1" }),
        host({ incarnation: "proc-2" }),
        host({ incarnation: null }),
        host({ hostId: "host-2", incarnation: "proc-1" }),
      ]),
      hostName,
    );
    const keys = status?.producers.map((line) => line.key) ?? [];
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
  });
});

describe("secretRotationStatus, one line per worker class", () => {
  it("shows one not-confirmed line for a class whose incarnations are all missing", () => {
    const status = secretRotationStatus(
      rotationOf("enforcing", [
        worker({
          workerClass: "https",
          incarnation: "i-1",
          status: "missing",
          evidence: null,
        }),
        worker({
          workerClass: "https",
          incarnation: "i-2",
          status: "missing",
          evidence: null,
        }),
      ]),
      hostName,
    );
    expect(status?.producers).toEqual([
      { key: "worker:https", text: "https: not confirmed yet" },
    ]);
  });

  it("sums the proof of every incarnation of a class into one line", () => {
    const status = secretRotationStatus(
      rotationOf("enforced", [
        worker({
          workerClass: "https",
          incarnation: "i-1",
          status: "acknowledged",
          evidence: [{ kind: "session_closed", count: 2 }],
        }),
        worker({
          workerClass: "https",
          incarnation: "i-2",
          status: "acknowledged",
          evidence: [
            { kind: "session_closed", count: 3 },
            { kind: "cache_cleared", count: 4 },
          ],
        }),
      ]),
      hostName,
    );
    expect(status?.producers).toEqual([
      {
        key: "worker:https",
        text: "https: 5 sessions closed, cached keys dropped",
      },
    ]);
  });

  it("reads not confirmed when one incarnation of a class is acknowledged and another is missing", () => {
    const status = secretRotationStatus(
      rotationOf("enforcing", [
        worker({
          workerClass: "https",
          incarnation: "i-1",
          status: "acknowledged",
          evidence: [{ kind: "session_closed", count: 2 }],
        }),
        worker({
          workerClass: "https",
          incarnation: "i-2",
          status: "missing",
          evidence: null,
        }),
      ]),
      hostName,
    );
    expect(status?.producers).toEqual([
      { key: "worker:https", text: "https: not confirmed yet" },
    ]);
  });
});

describe("secretRotationSettled", () => {
  it("is settled with no rotation, and with a failed one", () => {
    expect(secretRotationSettled(null)).toBe(true);
    expect(secretRotationSettled(rotationOf("failed", []))).toBe(true);
  });

  it("is settled once enforced with every producer proved", () => {
    expect(
      secretRotationSettled(
        rotationOf("enforced", [
          worker({}),
          host({ status: "applies_on_resume", evidence: null }),
        ]),
      ),
    ).toBe(true);
  });

  it("is still moving when enforced but a producer has proved nothing", () => {
    expect(
      secretRotationSettled(
        rotationOf("enforced", [
          worker({ evidence: [{ kind: "session_closed", count: 0 }] }),
        ]),
      ),
    ).toBe(false);
    expect(
      secretRotationSettled(
        rotationOf("enforced", [worker({ status: "missing", evidence: null })]),
      ),
    ).toBe(false);
  });

  it.each(["accepted", "enforcing", "stalled"] as const)(
    "is still moving while the state is %s",
    (state) => {
      expect(secretRotationSettled(rotationOf(state, [worker({})]))).toBe(
        false,
      );
    },
  );
});
