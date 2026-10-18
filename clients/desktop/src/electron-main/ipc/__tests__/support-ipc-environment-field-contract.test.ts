import { describe, expect, it } from "vitest";
import { parseSupportSubmitReportRequest } from "../support-ipc";

// E18 stage 4, checkpoint 5 (B.1): the environment section's closed contract,
// field by field. `support-ipc.test.ts` pins the key sets, the 15 refused
// names, the bounds of nine fields and the shapes of the whole; this file pins
// what a mutation of each remaining field's parser survived: the bound of every
// other code field, a wrong TYPE where a number or a list belongs, and a
// principal that is not one of the two categories. One valid section is built
// here, then ONE field at a time is made wrong.

const CAUSE = {
  type: "RangeError",
  message: "index out of bounds",
  stack: "at foo (bar.ts:1:1)",
  componentStack: null,
  errorCode: "E_BOUNDS",
  sourceAction: "chat.subscribe",
  timestamp: 1_700_000_000_000,
};

const KNOWN = { status: "known", value: "x" };
const UNAVAILABLE = { status: "unavailable" };

const REGISTRY = {
  routeTemplate: KNOWN,
  hostId: KNOWN,
  // As `support-ipc.test.ts` builds it.
  tabHostId: { status: "known", value: "host-tab-1" },
  epicId: KNOWN,
  tabId: KNOWN,
  artifactId: UNAVAILABLE,
  chatId: KNOWN,
  agentId: KNOWN,
  harnessId: KNOWN,
  model: KNOWN,
  profileId: { status: "known", value: null },
  providerSelectionClass: { status: "known", value: "bundled" },
  providerVersion: { status: "stale", value: null },
};

const FORM = {
  draftId: 1,
  type: "bug",
  intent: "It broke",
  frequency: "sometimes",
  location: null,
  allowContact: false,
  includeDesktopLog: true,
  includeHostLog: true,
  includeBrowserDiagnostics: true,
  includeDiagnostics: true,
  images: [],
  overrideTitle: null,
  privateOutcome: "delivered",
};

interface Section {
  hostId: string;
  principal: string | null;
  reachability: string;
  bindingGeneration: unknown;
  desiredRevision: unknown;
  receivedRevision: unknown;
  appliedRevision: unknown;
  receiptAgeMs: unknown;
  items: unknown;
  setupAttempts: unknown;
  policy: unknown;
  rotations: unknown;
  reachDenials: unknown;
  servedTask: unknown;
}

function validSection(): Section {
  return {
    hostId: "host-1",
    principal: "team",
    reachability: "connected",
    bindingGeneration: 3,
    desiredRevision: 7,
    receivedRevision: 7,
    appliedRevision: 6,
    receiptAgeMs: 1200,
    items: [
      {
        kind: "mcp_server",
        key: "github",
        os: "all",
        status: "failed",
        code: "unsupported_kind",
        args: {
          exitStatus: 2,
          stage: "install",
          durationMs: 4100,
          kind: "headers_in_sandbox",
        },
      },
    ],
    setupAttempts: [
      {
        attemptId: "attempt-1",
        scriptHash: "sha256:abc",
        trigger: "manual",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_004_100,
        exitStatus: 2,
        stageReached: "install",
        result: "failed",
      },
    ],
    policy: {
      source: "account",
      readState: "ready",
      teamState: null,
      teamPolicyVersion: null,
    },
    rotations: [
      {
        secretName: "STRIPE_KEY",
        state: "enforced",
        producers: [
          {
            producer: "worker",
            workerClass: "https",
            hostId: null,
            hostName: null,
            status: "acknowledged",
            evidence: [{ kind: "session_closed", count: 2 }],
          },
          {
            producer: "host",
            workerClass: null,
            hostId: "host-2",
            hostName: null,
            status: "acknowledged",
            evidence: null,
          },
        ],
      },
    ],
    reachDenials: [
      {
        denialId: "denial-1",
        at: 1_700_000_000_000,
        sourceHostRef: "host-ref-source",
        targetHostRef: "host-ref-target",
        taskRef: "task-ref-1",
        reason: "principal_mismatch",
        sourcePrincipal: "personal",
        targetPrincipal: "team",
        count: 3,
      },
    ],
    servedTask: {
      taskRef: "task-ref-1",
      otherHostPrincipals: ["personal", "team", "unknown"],
    },
  };
}

function submit(section: object): void {
  parseSupportSubmitReportRequest({
    ...FORM,
    privateDiagnostics: {
      cause: CAUSE,
      registry: REGISTRY,
      fingerprint: "fp:v1:abc",
      stackFamily: "stack:v1:abc",
      correlationId: "corr-1",
      environment: { status: "known", value: section },
    },
  });
}

/** A path into the valid section, and what writing a value there does to it. */
interface Spot {
  readonly name: string;
  readonly put: (section: Section, value: unknown) => void;
}

function firstItem(section: Section): Record<string, unknown> {
  return (section.items as Record<string, unknown>[])[0];
}
function firstAttempt(section: Section): Record<string, unknown> {
  return (section.setupAttempts as Record<string, unknown>[])[0];
}
function firstRotation(section: Section): Record<string, unknown> {
  return (section.rotations as Record<string, unknown>[])[0];
}
function firstDenial(section: Section): Record<string, unknown> {
  return (section.reachDenials as Record<string, unknown>[])[0];
}
function servedTask(section: Section): Record<string, unknown> {
  return section.servedTask as Record<string, unknown>;
}
function producer(section: Section, index: number): Record<string, unknown> {
  return (firstRotation(section).producers as Record<string, unknown>[])[index];
}

// Every field the 64-character code bound governs that `support-ipc.test.ts`'s
// table does not reach (it has the reachability, an item's stage, an evidence
// kind and the three ids).
const CODE_SPOTS: readonly Spot[] = [
  { name: "an item's kind", put: (s, v) => (firstItem(s).kind = v) },
  { name: "an item's os", put: (s, v) => (firstItem(s).os = v) },
  { name: "an item's status", put: (s, v) => (firstItem(s).status = v) },
  { name: "an item's code", put: (s, v) => (firstItem(s).code = v) },
  {
    name: "an item's args.kind",
    put: (s, v) => ((firstItem(s).args as Record<string, unknown>).kind = v),
  },
  {
    name: "a setup attempt's trigger",
    put: (s, v) => (firstAttempt(s).trigger = v),
  },
  {
    name: "a setup attempt's stageReached",
    put: (s, v) => (firstAttempt(s).stageReached = v),
  },
  {
    name: "a setup attempt's result",
    put: (s, v) => (firstAttempt(s).result = v),
  },
  {
    name: "the policy's source",
    put: (s, v) => ((s.policy as Record<string, unknown>).source = v),
  },
  {
    name: "the policy's readState",
    put: (s, v) => ((s.policy as Record<string, unknown>).readState = v),
  },
  {
    name: "the policy's teamState",
    put: (s, v) => ((s.policy as Record<string, unknown>).teamState = v),
  },
  {
    name: "the policy's teamPolicyVersion",
    put: (s, v) =>
      ((s.policy as Record<string, unknown>).teamPolicyVersion = v),
  },
  { name: "a rotation's state", put: (s, v) => (firstRotation(s).state = v) },
  { name: "a producer's kind", put: (s, v) => (producer(s, 0).producer = v) },
  {
    name: "a worker producer's workerClass",
    put: (s, v) => (producer(s, 0).workerClass = v),
  },
  {
    name: "a worker producer's status",
    put: (s, v) => (producer(s, 0).status = v),
  },
  {
    name: "a host producer's status",
    put: (s, v) => (producer(s, 1).status = v),
  },
];

describe("an environment section's code fields", () => {
  it("is accepted as built, so every rejection below is its one field", () => {
    expect(() => submit(validSection())).not.toThrow();
  });

  it.each(CODE_SPOTS)("accepts $name of exactly 64 characters", (spot) => {
    const section = validSection();
    spot.put(section, "c".repeat(64));
    expect(() => submit(section)).not.toThrow();
  });

  it.each(CODE_SPOTS)("rejects $name one character past 64", (spot) => {
    const section = validSection();
    spot.put(section, "c".repeat(65));
    expect(() => submit(section)).toThrow("is longer than 64 characters");
  });
});

// Every number a section carries. A string where a number belongs would ride
// into the report unscrubbed, so the parser refuses it by type.
const NUMBER_SPOTS: readonly Spot[] = [
  { name: "bindingGeneration", put: (s, v) => (s.bindingGeneration = v) },
  { name: "desiredRevision", put: (s, v) => (s.desiredRevision = v) },
  { name: "receivedRevision", put: (s, v) => (s.receivedRevision = v) },
  { name: "appliedRevision", put: (s, v) => (s.appliedRevision = v) },
  { name: "receiptAgeMs", put: (s, v) => (s.receiptAgeMs = v) },
  {
    name: "an item's args.exitStatus",
    put: (s, v) =>
      ((firstItem(s).args as Record<string, unknown>).exitStatus = v),
  },
  {
    name: "an item's args.durationMs",
    put: (s, v) =>
      ((firstItem(s).args as Record<string, unknown>).durationMs = v),
  },
  {
    name: "a setup attempt's startedAt",
    put: (s, v) => (firstAttempt(s).startedAt = v),
  },
  {
    name: "a setup attempt's endedAt",
    put: (s, v) => (firstAttempt(s).endedAt = v),
  },
  {
    name: "a setup attempt's exitStatus",
    put: (s, v) => (firstAttempt(s).exitStatus = v),
  },
  {
    name: "an evidence entry's count",
    put: (s, v) => {
      const evidence = producer(s, 0).evidence as Record<string, unknown>[];
      evidence[0].count = v;
    },
  },
];

describe("an environment section's numbers", () => {
  it.each(NUMBER_SPOTS)("refuses a string in $name", (spot) => {
    const section = validSection();
    spot.put(section, "Bearer sk_live_not_a_number");
    expect(() => submit(section)).toThrow(/requires a finite number argument/);
  });

  it.each(NUMBER_SPOTS)(
    "refuses a number that is not finite in $name",
    (spot) => {
      const section = validSection();
      spot.put(section, Number.POSITIVE_INFINITY);
      expect(() => submit(section)).toThrow(
        /requires a finite number argument/,
      );
    },
  );

  it.each(NUMBER_SPOTS)("refuses an object in $name", (spot) => {
    const section = validSection();
    spot.put(section, { token: "sk_live_not_a_number" });
    expect(() => submit(section)).toThrow(/requires a finite number argument/);
  });
});

describe("an environment section's lists and categories", () => {
  it.each([
    ["items", (s: Section, v: unknown) => (s.items = v)],
    ["setupAttempts", (s: Section, v: unknown) => (s.setupAttempts = v)],
    ["rotations", (s: Section, v: unknown) => (s.rotations = v)],
    [
      "a rotation's producers",
      (s: Section, v: unknown) => (firstRotation(s).producers = v),
    ],
    [
      "a producer's evidence",
      (s: Section, v: unknown) => (producer(s, 0).evidence = v),
    ],
  ])("refuses an object where %s belongs", (_name, put) => {
    const section = validSection();
    put(section, { "0": { token: "sk_live_x" } });
    expect(() => submit(section)).toThrow("must be an array");
  });

  it.each(["owner", "admin", "Acme", ""])(
    "refuses principal %j: only personal, team or null",
    (principal) => {
      const section = validSection();
      section.principal = principal;
      expect(() => submit(section)).toThrow(
        /principal must be "personal", "team", or null/,
      );
    },
  );

  it.each(["personal", "team", null])("accepts principal %j", (principal) => {
    const section = validSection();
    section.principal = principal;
    expect(() => submit(section)).not.toThrow();
  });
});

// Ticket E13, checkpoint 4: the reach section, field by field. Its ids are
// opaque references bounded at 256 characters; its two principal fields are a
// closed set of three categories; the reason is one literal.
const REACH_ID_SPOTS: readonly Spot[] = [
  { name: "a denial's denialId", put: (s, v) => (firstDenial(s).denialId = v) },
  {
    name: "a denial's sourceHostRef",
    put: (s, v) => (firstDenial(s).sourceHostRef = v),
  },
  {
    name: "a denial's targetHostRef",
    put: (s, v) => (firstDenial(s).targetHostRef = v),
  },
  { name: "a denial's taskRef", put: (s, v) => (firstDenial(s).taskRef = v) },
  {
    name: "the served task's taskRef",
    put: (s, v) => (servedTask(s).taskRef = v),
  },
];

describe("an environment section's reach fields", () => {
  it.each(REACH_ID_SPOTS)("accepts $name of exactly 256 characters", (spot) => {
    const section = validSection();
    spot.put(section, "r".repeat(256));
    expect(() => submit(section)).not.toThrow();
  });

  it.each(REACH_ID_SPOTS)("rejects $name one character past 256", (spot) => {
    const section = validSection();
    spot.put(section, "r".repeat(257));
    expect(() => submit(section)).toThrow("is longer than 256 characters");
  });

  it.each(REACH_ID_SPOTS)("refuses a number in $name", (spot) => {
    const section = validSection();
    spot.put(section, 42);
    expect(() => submit(section)).toThrow(/requires a string argument/);
  });

  it("accepts a denial with no task", () => {
    const section = validSection();
    firstDenial(section).taskRef = null;
    expect(() => submit(section)).not.toThrow();
  });

  it.each([
    ["at", (s: Section, v: unknown) => (firstDenial(s).at = v)],
    ["count", (s: Section, v: unknown) => (firstDenial(s).count = v)],
  ])("refuses a string in a denial's %s", (_name, put) => {
    const section = validSection();
    put(section, "Bearer sk_live_not_a_number");
    expect(() => submit(section)).toThrow(/requires a finite number argument/);
  });

  it.each(["sourcePrincipal", "targetPrincipal"])(
    "refuses a denial's %s outside personal, team and unknown",
    (key) => {
      for (const bad of ["owner", "Acme", "", "Team", 7, null]) {
        const section = validSection();
        firstDenial(section)[key] = bad;
        expect(() => submit(section)).toThrow(
          /must be "personal", "team", or "unknown"/,
        );
      }
    },
  );

  it.each(["personal", "team", "unknown"])(
    "accepts %j as a denial's principal and as a served task's principal",
    (category) => {
      const section = validSection();
      firstDenial(section).sourcePrincipal = category;
      firstDenial(section).targetPrincipal = category;
      servedTask(section).otherHostPrincipals = [category];
      expect(() => submit(section)).not.toThrow();
    },
  );

  it("refuses a served task principal outside the three categories", () => {
    const section = validSection();
    servedTask(section).otherHostPrincipals = ["personal", "Acme"];
    expect(() => submit(section)).toThrow(
      /must be "personal", "team", or "unknown"/,
    );
  });

  it.each(["no_such_host", "", "PRINCIPAL_MISMATCH", null])(
    "refuses reason %j: only principal_mismatch",
    (reason) => {
      const section = validSection();
      firstDenial(section).reason = reason;
      expect(() => submit(section)).toThrow(
        'reason must be "principal_mismatch"',
      );
    },
  );

  it.each([
    ["reachDenials", (s: Section, v: unknown) => (s.reachDenials = v)],
    [
      "a served task's otherHostPrincipals",
      (s: Section, v: unknown) => (servedTask(s).otherHostPrincipals = v),
    ],
  ])("refuses an object where %s belongs", (_name, put) => {
    const section = validSection();
    put(section, { "0": { token: "sk_live_x" } });
    expect(() => submit(section)).toThrow("must be an array");
  });
});
