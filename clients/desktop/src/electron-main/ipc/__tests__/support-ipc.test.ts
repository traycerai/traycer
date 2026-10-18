import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  REPORT_LOG_TAIL_MAX_BYTES,
  TOTAL_ATTACHMENT_BUDGET_BYTES,
} from "@traycer-clients/shared/support/image-attachment-guards";
import type {
  SupportEnvironmentItem,
  SupportEnvironmentPolicy,
  SupportEnvironmentReachDenial,
  SupportEnvironmentRotation,
  SupportEnvironmentRotationEvidence,
  SupportEnvironmentRotationProducer,
  SupportEnvironmentSection,
  SupportEnvironmentServedTask,
  SupportEnvironmentSetupAttempt,
} from "../../../ipc-contracts/window-types";
import {
  parseSupportFreezeEvidenceInput,
  parseSupportReadFrozenLogTailInput,
  parseSupportSubmitReportRequest,
  parseSupportTailLogInput,
} from "../support-ipc";

const VALID_FORM = {
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

describe("parseSupportTailLogInput", () => {
  it("accepts and clamps a valid request", () => {
    expect(
      parseSupportTailLogInput({ target: "host", tailLines: 1_000 }),
    ).toEqual({ target: "host", tailLines: 500 });
  });

  it.each([null, "desktop", [], 42])(
    "rejects a malformed request payload",
    (input) => {
      expect(() => parseSupportTailLogInput(input)).toThrow();
    },
  );
});

/** Small valid PNG magic + padding. */
function pngArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return bytes.buffer;
}

function jpegArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes.buffer;
}

function gifArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x47;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x38;
  return bytes.buffer;
}

function webpArrayBuffer(length: number): ArrayBuffer {
  const bytes = new Uint8Array(Math.max(length, 12));
  bytes[0] = 0x52;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x46;
  bytes[8] = 0x57;
  bytes[9] = 0x45;
  bytes[10] = 0x42;
  bytes[11] = 0x50;
  return bytes.buffer;
}

const SMALL_PNG = (): ArrayBuffer => pngArrayBuffer(32);
const SMALL_JPEG = (): ArrayBuffer => jpegArrayBuffer(32);
const SMALL_GIF = (): ArrayBuffer => gifArrayBuffer(32);
const SMALL_WEBP = (): ArrayBuffer => webpArrayBuffer(32);

function imageAttachment(overrides: {
  readonly fileName: string | undefined;
  readonly mimeType: string | undefined;
  readonly bytes: ArrayBuffer | undefined;
}) {
  return {
    fileName: overrides.fileName ?? "shot.png",
    mimeType: overrides.mimeType ?? "image/png",
    bytes: overrides.bytes ?? SMALL_PNG(),
  };
}

function defaultImageAttachment() {
  return imageAttachment({
    fileName: undefined,
    mimeType: undefined,
    bytes: undefined,
  });
}

const VALID_CAUSE = {
  type: "RangeError",
  message: "index out of bounds",
  stack: "at foo (bar.ts:1:1)",
  componentStack: null,
  errorCode: "E_BOUNDS",
  sourceAction: "chat.subscribe",
  timestamp: 1_700_000_000_000,
};

const KNOWN_STRING = { status: "known", value: "epic-1" };
const STALE_STRING = { status: "stale", value: "tab-1" };
const UNAVAILABLE = { status: "unavailable" };

// Field-for-field match with ticket 05's `SupportContextSnapshot`
// (clients/gui-app/src/lib/support-context-registry.ts).
const VALID_REGISTRY = {
  routeTemplate: KNOWN_STRING,
  hostId: KNOWN_STRING,
  tabHostId: { status: "known", value: "host-tab-1" },
  epicId: KNOWN_STRING,
  tabId: STALE_STRING,
  artifactId: UNAVAILABLE,
  chatId: KNOWN_STRING,
  agentId: KNOWN_STRING,
  harnessId: KNOWN_STRING,
  model: KNOWN_STRING,
  profileId: { status: "known", value: null },
  providerSelectionClass: { status: "known", value: "bundled" },
  providerVersion: { status: "stale", value: null },
};

const VALID_PRIVATE_DIAGNOSTICS = {
  cause: VALID_CAUSE,
  registry: VALID_REGISTRY,
  fingerprint: "fp:v1:abc",
  stackFamily: "stack:v1:abc",
  correlationId: "corr-1",
  environment: UNAVAILABLE,
};

// Ticket E11, checkpoint 5: a fully populated environment section, every
// record and every nullable arm present at least once.
const ENV_ITEM: SupportEnvironmentItem = {
  kind: "env_var",
  key: "DATABASE_URL",
  os: "all",
  status: "applied",
  code: "ok",
  args: { exitStatus: null, stage: null, durationMs: null, kind: null },
};

const ENV_FAILED_ITEM: SupportEnvironmentItem = {
  kind: "setup_script",
  key: "setup",
  os: "linux",
  status: "failed",
  code: "setup_failed",
  args: { exitStatus: 2, stage: "install", durationMs: 4100, kind: "script" },
};

const ENV_ATTEMPT: SupportEnvironmentSetupAttempt = {
  attemptId: "attempt-1",
  scriptHash: "sha256:abc123",
  trigger: "manual",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_004_100,
  exitStatus: 2,
  stageReached: "install",
  result: "failed",
};

const ENV_OPEN_ATTEMPT: SupportEnvironmentSetupAttempt = {
  ...ENV_ATTEMPT,
  attemptId: "attempt-2",
  endedAt: null,
  exitStatus: null,
  stageReached: null,
  result: null,
};

const ENV_POLICY: SupportEnvironmentPolicy = {
  source: "account",
  readState: "ready",
  teamState: null,
  teamPolicyVersion: null,
};

const ENV_EVIDENCE: SupportEnvironmentRotationEvidence = {
  kind: "sessions",
  count: 2,
};

const ENV_WORKER_PRODUCER: SupportEnvironmentRotationProducer = {
  producer: "worker",
  workerClass: "sandbox",
  hostId: null,
  hostName: null,
  status: "pending",
  evidence: [ENV_EVIDENCE],
};

const ENV_HOST_PRODUCER: SupportEnvironmentRotationProducer = {
  producer: "host",
  workerClass: null,
  hostId: "host-2",
  hostName: null,
  status: "done",
  evidence: null,
};

const ENV_ROTATION: SupportEnvironmentRotation = {
  secretName: "STRIPE_KEY",
  state: "rotating",
  producers: [ENV_WORKER_PRODUCER, ENV_HOST_PRODUCER],
};

// Ticket E13, checkpoint 4: the reach section. A denial is opaque references
// and principal categories; the same-principal refusal reads "personal" and
// "team" so a mismatch is visible without naming anyone.
const ENV_REACH_DENIAL: SupportEnvironmentReachDenial = {
  denialId: "denial-1",
  at: 1_700_000_000_000,
  sourceHostRef: "host-ref-source",
  targetHostRef: "host-ref-target",
  taskRef: "task-ref-1",
  reason: "principal_mismatch",
  sourcePrincipal: "personal",
  targetPrincipal: "team",
  count: 3,
};

const ENV_REACH_DENIAL_NO_TASK: SupportEnvironmentReachDenial = {
  ...ENV_REACH_DENIAL,
  denialId: "denial-2",
  taskRef: null,
  sourcePrincipal: "unknown",
  targetPrincipal: "unknown",
  count: 1,
};

const ENV_SERVED_TASK: SupportEnvironmentServedTask = {
  taskRef: "task-ref-1",
  otherHostPrincipals: ["personal", "team", "unknown"],
};

const FULL_ENVIRONMENT_SECTION: SupportEnvironmentSection = {
  hostId: "host-1",
  principal: "team",
  reachability: "reachable",
  bindingGeneration: 3,
  desiredRevision: 7,
  receivedRevision: 7,
  appliedRevision: 6,
  receiptAgeMs: 1200,
  items: [ENV_ITEM, ENV_FAILED_ITEM],
  setupAttempts: [ENV_ATTEMPT, ENV_OPEN_ATTEMPT],
  policy: ENV_POLICY,
  rotations: [ENV_ROTATION],
  reachDenials: [ENV_REACH_DENIAL, ENV_REACH_DENIAL_NO_TASK],
  servedTask: ENV_SERVED_TASK,
};

const KNOWN_ENVIRONMENT = {
  status: "known",
  value: FULL_ENVIRONMENT_SECTION,
};

function submitWithEnvironment(environment: object) {
  return parseSupportSubmitReportRequest({
    ...VALID_FORM,
    privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, environment },
  });
}

/** Submits `section` as a `known` environment field. */
function submitWithSection(section: object) {
  return submitWithEnvironment({ status: "known", value: section });
}

/** The full section with `patch` laid over it, for one bad field at a time. */
function sectionWith(patch: object): object {
  return { ...FULL_ENVIRONMENT_SECTION, ...patch };
}

describe("parseSupportSubmitReportRequest", () => {
  it("accepts a well-formed request with no privateDiagnostics", () => {
    expect(parseSupportSubmitReportRequest(VALID_FORM)).toEqual(VALID_FORM);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseSupportSubmitReportRequest(null)).toThrow();
    expect(() => parseSupportSubmitReportRequest("nope")).toThrow();
    expect(() => parseSupportSubmitReportRequest([VALID_FORM])).toThrow();
  });

  it("rejects a missing draftId", () => {
    const { draftId: _draftId, ...withoutDraftId } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutDraftId)).toThrow();
  });

  it("rejects a non-number draftId", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, draftId: "1" }),
    ).toThrow();
  });

  it("rejects a non-string intent", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, intent: 42 }),
    ).toThrow();
  });

  it("rejects a type outside bug/idea/other", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, type: "wish" }),
    ).toThrow();
  });

  it.each(["bug", "idea", "other"])("accepts type %s", (type) => {
    const result = parseSupportSubmitReportRequest({ ...VALID_FORM, type });
    expect(result.type).toBe(type);
  });

  it.each(["once", "sometimes", "every_time", "not_sure"])(
    "accepts frequency %s",
    (frequency) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        frequency,
      });
      expect(result.frequency).toBe(frequency);
    },
  );

  it("accepts a null frequency - the unselected/hidden default", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      frequency: null,
    });
    expect(result.frequency).toBeNull();
  });

  it("rejects a frequency outside the known set", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, frequency: "daily" }),
    ).toThrow();
  });

  it("rejects a missing frequency key - the wire always carries it", () => {
    const { frequency: _frequency, ...withoutFrequency } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutFrequency)).toThrow();
  });

  it("accepts a non-null location - the actively-changed selector value (D7)", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      location: "Terminal",
    });
    expect(result.location).toBe("Terminal");
  });

  it("rejects a missing location key - the wire always carries it", () => {
    const { location: _location, ...withoutLocation } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutLocation)).toThrow();
  });

  it("rejects a non-string non-null location", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, location: 42 }),
    ).toThrow();
  });

  it.each([true, false])("accepts allowContact %s", (allowContact) => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      allowContact,
    });
    expect(result.allowContact).toBe(allowContact);
  });

  it("rejects a non-boolean allowContact", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, allowContact: "yes" }),
    ).toThrow();
  });

  it.each(["includeDesktopLog", "includeHostLog"] as const)(
    "rejects a missing %s key",
    (key) => {
      const withoutKey = { ...VALID_FORM };
      delete (withoutKey as Record<string, unknown>)[key];
      expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
    },
  );

  it.each(["includeDesktopLog", "includeHostLog"] as const)(
    "rejects a non-boolean %s",
    (key) => {
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, [key]: "on" }),
      ).toThrow();
    },
  );

  it("accepts independently toggled log flags", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      includeDesktopLog: false,
      includeHostLog: true,
    });
    expect(result.includeDesktopLog).toBe(false);
    expect(result.includeHostLog).toBe(true);
  });

  it("rejects a missing includeBrowserDiagnostics key", () => {
    const {
      includeBrowserDiagnostics: _includeBrowserDiagnostics,
      ...withoutKey
    } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it("rejects a non-boolean includeBrowserDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        includeBrowserDiagnostics: "on",
      }),
    ).toThrow();
  });

  it.each([true, false])(
    "round-trips includeBrowserDiagnostics %s",
    (value) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        includeBrowserDiagnostics: value,
      });
      expect(result.includeBrowserDiagnostics).toBe(value);
    },
  );

  it("rejects a missing includeDiagnostics key", () => {
    const { includeDiagnostics: _includeDiagnostics, ...withoutKey } =
      VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it("rejects a non-boolean includeDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        includeDiagnostics: "yes",
      }),
    ).toThrow();
  });

  it.each([true, false])("accepts includeDiagnostics %s", (value) => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      includeDiagnostics: value,
    });
    expect(result.includeDiagnostics).toBe(value);
  });

  it("rejects a missing overrideTitle key - the wire always carries it", () => {
    const { overrideTitle: _overrideTitle, ...withoutKey } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it("accepts a null overrideTitle - the initial preview fetch", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      overrideTitle: null,
    });
    expect(result.overrideTitle).toBeNull();
  });

  it("accepts a non-null overrideTitle - the user's as-typed preview edit", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      overrideTitle: "Edited title",
    });
    expect(result.overrideTitle).toBe("Edited title");
  });

  it("rejects a non-string non-null overrideTitle", () => {
    expect(() =>
      parseSupportSubmitReportRequest({ ...VALID_FORM, overrideTitle: 42 }),
    ).toThrow();
  });

  it("rejects a missing privateOutcome key", () => {
    const { privateOutcome: _privateOutcome, ...withoutKey } = VALID_FORM;
    expect(() => parseSupportSubmitReportRequest(withoutKey)).toThrow();
  });

  it.each(["delivered", "unconfirmed", "none"])(
    "accepts privateOutcome %s",
    (privateOutcome) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateOutcome,
      });
      expect(result.privateOutcome).toBe(privateOutcome);
    },
  );

  it("rejects a privateOutcome outside delivered/unconfirmed/none", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateOutcome: "failed",
      }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field - the allowlist is not caller-discipline", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        secretPayload: { anything: "goes" },
      }),
    ).toThrow();
  });

  it("accepts a fully-populated privateDiagnostics payload", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: VALID_PRIVATE_DIAGNOSTICS,
    });
    expect(result.privateDiagnostics).toEqual(VALID_PRIVATE_DIAGNOSTICS);
  });

  it("accepts a null cause, fingerprint, and stackFamily - all real, non-error states", () => {
    const result = parseSupportSubmitReportRequest({
      ...VALID_FORM,
      privateDiagnostics: {
        ...VALID_PRIVATE_DIAGNOSTICS,
        cause: null,
        fingerprint: null,
        stackFamily: null,
      },
    });
    expect(result.privateDiagnostics?.cause).toBeNull();
    expect(result.privateDiagnostics?.fingerprint).toBeNull();
    expect(result.privateDiagnostics?.stackFamily).toBeNull();
  });

  it.each([
    "cause",
    "registry",
    "fingerprint",
    "stackFamily",
    "correlationId",
    "environment",
  ])(
    "rejects privateDiagnostics missing the required %s key - the serializer never omits it",
    (key) => {
      const withoutKey = { ...VALID_PRIVATE_DIAGNOSTICS };
      delete (withoutKey as Record<string, unknown>)[key];
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          privateDiagnostics: withoutKey,
        }),
      ).toThrow();
    },
  );

  it("rejects a non-string correlationId", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, correlationId: 1 },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: { ...VALID_PRIVATE_DIAGNOSTICS, extra: true },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: { ...VALID_CAUSE, workspacePath: "/Users/anurag/secret" },
        },
      }),
    ).toThrow();
  });

  it("rejects a non-finite timestamp in privateDiagnostics.cause", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: { ...VALID_CAUSE, timestamp: Number.NaN },
        },
      }),
    ).toThrow();
  });

  it("rejects an unlisted key inside privateDiagnostics.registry", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, rawFilePath: "/etc/passwd" },
        },
      }),
    ).toThrow();
  });

  it("rejects a providerSelectionClass value outside bundled/path/custom", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            providerSelectionClass: { status: "known", value: "vendored" },
          },
        },
      }),
    ).toThrow();
  });

  it.each(["known", "stale", "unavailable"])(
    "accepts a registry field with status %s",
    (status) => {
      const field =
        status === "unavailable" ? UNAVAILABLE : { status, value: "epic-2" };
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, epicId: field },
        },
      });
      expect(result.privateDiagnostics?.registry.epicId).toEqual(field);
    },
  );

  it("rejects a registry field with an unrecognized status", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            epicId: { status: "fresh", value: "epic-1" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a known registry field missing its value", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: { ...VALID_REGISTRY, epicId: { status: "known" } },
        },
      }),
    ).toThrow();
  });

  it("rejects nullable known or stale fields missing their value", () => {
    for (const field of ["profileId", "providerVersion"] as const) {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          privateDiagnostics: {
            ...VALID_PRIVATE_DIAGNOSTICS,
            registry: {
              ...VALID_REGISTRY,
              [field]: { status: "known" },
            },
          },
        }),
      ).toThrow(/missing required field: value/);
    }
  });

  it("rejects an unavailable registry field carrying a stray value", () => {
    expect(() =>
      parseSupportSubmitReportRequest({
        ...VALID_FORM,
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          registry: {
            ...VALID_REGISTRY,
            epicId: { status: "unavailable", value: "epic-1" },
          },
        },
      }),
    ).toThrow();
  });

  describe("privateDiagnostics.environment (ticket E11, checkpoint 5)", () => {
    it("accepts a fully populated known section and returns it unchanged", () => {
      const result = submitWithEnvironment(KNOWN_ENVIRONMENT);
      expect(result.privateDiagnostics?.environment).toEqual(KNOWN_ENVIRONMENT);
    });

    it("accepts a stale section the same way", () => {
      const stale = { status: "stale", value: FULL_ENVIRONMENT_SECTION };
      const result = submitWithEnvironment(stale);
      expect(result.privateDiagnostics?.environment).toEqual(stale);
    });

    it("accepts an unavailable section and returns it unchanged", () => {
      const result = submitWithEnvironment(UNAVAILABLE);
      expect(result.privateDiagnostics?.environment).toEqual(UNAVAILABLE);
    });

    it("accepts a section whose every nullable member is null", () => {
      const sparse: SupportEnvironmentSection = {
        hostId: "host-1",
        principal: null,
        reachability: "unreachable",
        bindingGeneration: null,
        desiredRevision: null,
        receivedRevision: null,
        appliedRevision: null,
        receiptAgeMs: null,
        items: [],
        setupAttempts: null,
        policy: null,
        rotations: null,
        reachDenials: null,
        servedTask: null,
      };
      const result = submitWithSection(sparse);
      expect(result.privateDiagnostics?.environment).toEqual({
        status: "known",
        value: sparse,
      });
    });

    it("rejects privateDiagnostics sent without environment, by name", () => {
      const { environment: _environment, ...withoutEnvironment } =
        VALID_PRIVATE_DIAGNOSTICS;
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          privateDiagnostics: withoutEnvironment,
        }),
      ).toThrow("missing required field: environment");
    });

    // The ruling's "never a key" list: each is refused by NAME, so a field
    // added to the renderer's type fails here until it is added on purpose.
    it.each([
      "pendingUploads",
      "localOverrides",
      "setupScript",
      "setupOutput",
      "value",
      "snapshot",
      "policyBody",
      "profile",
      "cost",
      "routes",
      "privateAgents",
      "teamName",
      "ownerLabel",
      "connector",
      "connectorDetail",
    ])("rejects %s added to the section, naming it", (key) => {
      expect(() =>
        submitWithSection(sectionWith({ [key]: "anything" })),
      ).toThrow(`contains a disallowed field: ${key}`);
    });

    it("accepts a team host's policy state and version and returns them unchanged", () => {
      const team: SupportEnvironmentSection = {
        ...FULL_ENVIRONMENT_SECTION,
        policy: {
          ...ENV_POLICY,
          teamState: "applied",
          teamPolicyVersion: "42",
        },
      };

      const result = submitWithSection(team);

      expect(result.privateDiagnostics?.environment).toEqual({
        status: "known",
        value: team,
      });
    });

    it.each([
      [
        "teamState",
        { source: "account", readState: "ready", teamPolicyVersion: null },
      ],
      [
        "teamPolicyVersion",
        { source: "account", readState: "ready", teamState: null },
      ],
    ])("rejects a policy without %s, naming it", (key, policy) => {
      expect(() => submitWithSection(sectionWith({ policy }))).toThrow(
        `is missing required field: ${key}`,
      );
    });

    it.each(["teamState", "teamPolicyVersion"])(
      "rejects a non-string %s",
      (key) => {
        expect(() =>
          submitWithSection(
            sectionWith({ policy: { ...ENV_POLICY, [key]: 7 } }),
          ),
        ).toThrow();
      },
    );

    it("still rejects an unknown key beside the two team keys", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            policy: {
              ...ENV_POLICY,
              teamState: "applied",
              teamPolicyVersion: "42",
              teamPolicyBody: "never ship",
            },
          }),
        ),
      ).toThrow("contains a disallowed field: teamPolicyBody");
    });

    it("rejects a body added to the policy", () => {
      expect(() =>
        submitWithSection(
          sectionWith({ policy: { ...ENV_POLICY, body: "never ship" } }),
        ),
      ).toThrow("contains a disallowed field: body");
    });

    it("rejects a value added to an item", () => {
      expect(() =>
        submitWithSection(
          sectionWith({ items: [{ ...ENV_ITEM, value: "postgres://x" }] }),
        ),
      ).toThrow("contains a disallowed field: value");
    });

    it("rejects an extra key on an item's args", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            items: [
              { ...ENV_ITEM, args: { ...ENV_ITEM.args, command: "rm -rf /" } },
            ],
          }),
        ),
      ).toThrow("contains a disallowed field: command");
    });

    it("rejects an output added to a setup attempt", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            setupAttempts: [{ ...ENV_ATTEMPT, output: "npm ERR! secret" }],
          }),
        ),
      ).toThrow("contains a disallowed field: output");
    });

    it("rejects a teamName on a rotation", () => {
      expect(() =>
        submitWithSection(
          sectionWith({ rotations: [{ ...ENV_ROTATION, teamName: "Acme" }] }),
        ),
      ).toThrow("contains a disallowed field: teamName");
    });

    it("rejects an extra key on a rotation producer", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            rotations: [
              {
                ...ENV_ROTATION,
                producers: [{ ...ENV_HOST_PRODUCER, hostLabel: "Alice's Mac" }],
              },
            ],
          }),
        ),
      ).toThrow("contains a disallowed field: hostLabel");
    });

    it("rejects an extra key on a rotation evidence entry", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            rotations: [
              {
                ...ENV_ROTATION,
                producers: [
                  {
                    ...ENV_WORKER_PRODUCER,
                    evidence: [{ ...ENV_EVIDENCE, detail: "free text" }],
                  },
                ],
              },
            ],
          }),
        ),
      ).toThrow("contains a disallowed field: detail");
    });

    it("rejects a section missing one of its keys, by name", () => {
      const { reachability: _reachability, ...withoutReachability } =
        FULL_ENVIRONMENT_SECTION;
      expect(() => submitWithSection(withoutReachability)).toThrow(
        "missing required field: reachability",
      );
    });

    it("rejects a section missing reachDenials, by name", () => {
      const { reachDenials: _reachDenials, ...withoutReachDenials } =
        FULL_ENVIRONMENT_SECTION;
      expect(() => submitWithSection(withoutReachDenials)).toThrow(
        "missing required field: reachDenials",
      );
    });

    it("rejects a section missing servedTask, by name", () => {
      const { servedTask: _servedTask, ...withoutServedTask } =
        FULL_ENVIRONMENT_SECTION;
      expect(() => submitWithSection(withoutServedTask)).toThrow(
        "missing required field: servedTask",
      );
    });

    // Ticket E13, checkpoint 4: a refusal is references and categories only.
    // These three are the pins: a host's label, a person's display name or an
    // owner's id inside a denial is refused by NAME, never passed through.
    it("refuses a reach denial carrying a host label", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            reachDenials: [{ ...ENV_REACH_DENIAL, label: "Alice's Mac" }],
          }),
        ),
      ).toThrow("contains a disallowed field: label");
    });

    it("refuses a reach denial carrying a displayName", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            reachDenials: [{ ...ENV_REACH_DENIAL, displayName: "Alice" }],
          }),
        ),
      ).toThrow("contains a disallowed field: displayName");
    });

    it("refuses a reach denial carrying an ownerId", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            reachDenials: [{ ...ENV_REACH_DENIAL, ownerId: "user-42" }],
          }),
        ),
      ).toThrow("contains a disallowed field: ownerId");
    });

    it("refuses a served task carrying an extra key", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            servedTask: { ...ENV_SERVED_TASK, hostLabel: "Alice's Mac" },
          }),
        ),
      ).toThrow("contains a disallowed field: hostLabel");
    });

    it("accepts a reach denial and a served task and returns them unchanged", () => {
      const result = submitWithSection(FULL_ENVIRONMENT_SECTION);
      expect(result.privateDiagnostics?.environment).toEqual({
        status: "known",
        value: FULL_ENVIRONMENT_SECTION,
      });
    });

    it("accepts an empty denials list and a null served task", () => {
      const quiet: SupportEnvironmentSection = {
        ...FULL_ENVIRONMENT_SECTION,
        reachDenials: [],
        servedTask: null,
      };
      const result = submitWithSection(quiet);
      expect(result.privateDiagnostics?.environment).toEqual({
        status: "known",
        value: quiet,
      });
    });

    it("refuses a reach denial reason other than principal_mismatch", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            reachDenials: [{ ...ENV_REACH_DENIAL, reason: "no_such_host" }],
          }),
        ),
      ).toThrow('reason must be "principal_mismatch"');
    });

    it.each(["sourcePrincipal", "targetPrincipal"])(
      "refuses a reach denial %s outside personal, team and unknown",
      (key) => {
        expect(() =>
          submitWithSection(
            sectionWith({
              reachDenials: [{ ...ENV_REACH_DENIAL, [key]: "Acme" }],
            }),
          ),
        ).toThrow('must be "personal", "team", or "unknown"');
      },
    );

    it("refuses a served task principal outside personal, team and unknown", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            servedTask: { ...ENV_SERVED_TASK, otherHostPrincipals: ["Acme"] },
          }),
        ),
      ).toThrow('must be "personal", "team", or "unknown"');
    });

    it("rejects an item missing one of its keys, by name", () => {
      const { os: _os, ...itemWithoutOs } = ENV_ITEM;
      expect(() =>
        submitWithSection(sectionWith({ items: [itemWithoutOs] })),
      ).toThrow("missing required field: os");
    });

    // Each row: where the text sits, its limit, and a section carrying `text`
    // there. The limits are `SUPPORT_ENVIRONMENT_TEXT_MAX`'s, restated here on
    // purpose: a loosened bound in the parser must fail this table.
    const TEXT_BOUNDS: readonly {
      readonly field: string;
      readonly max: number;
      readonly build: (text: string) => object;
    }[] = [
      {
        field: "an item key",
        max: 3072,
        build: (text) => sectionWith({ items: [{ ...ENV_ITEM, key: text }] }),
      },
      {
        field: "a secret name",
        max: 128,
        build: (text) =>
          sectionWith({
            rotations: [{ ...ENV_ROTATION, secretName: text }],
          }),
      },
      {
        field: "the reachability code",
        max: 64,
        build: (text) => sectionWith({ reachability: text }),
      },
      {
        field: "an item's stage code",
        max: 64,
        build: (text) =>
          sectionWith({
            items: [{ ...ENV_ITEM, args: { ...ENV_ITEM.args, stage: text } }],
          }),
      },
      {
        field: "an evidence kind",
        max: 64,
        build: (text) =>
          sectionWith({
            rotations: [
              {
                ...ENV_ROTATION,
                producers: [
                  {
                    ...ENV_WORKER_PRODUCER,
                    evidence: [{ ...ENV_EVIDENCE, kind: text }],
                  },
                ],
              },
            ],
          }),
      },
      {
        field: "the host id",
        max: 256,
        build: (text) => sectionWith({ hostId: text }),
      },
      {
        field: "a producer's host id",
        max: 256,
        build: (text) =>
          sectionWith({
            rotations: [
              {
                ...ENV_ROTATION,
                producers: [{ ...ENV_HOST_PRODUCER, hostId: text }],
              },
            ],
          }),
      },
      {
        field: "a setup attempt id",
        max: 256,
        build: (text) =>
          sectionWith({
            setupAttempts: [{ ...ENV_ATTEMPT, attemptId: text }],
          }),
      },
      {
        field: "a script hash",
        max: 128,
        build: (text) =>
          sectionWith({
            setupAttempts: [{ ...ENV_ATTEMPT, scriptHash: text }],
          }),
      },
    ];

    it.each(TEXT_BOUNDS)("accepts $field of exactly $max characters", (row) => {
      expect(() =>
        submitWithSection(row.build("k".repeat(row.max))),
      ).not.toThrow();
    });

    it.each(TEXT_BOUNDS)("rejects $field one character past $max", (row) => {
      expect(() =>
        submitWithSection(row.build("k".repeat(row.max + 1))),
      ).toThrow(`is longer than ${row.max} characters`);
    });

    it("rejects a producer whose hostName is a string", () => {
      expect(() =>
        submitWithSection(
          sectionWith({
            rotations: [
              {
                ...ENV_ROTATION,
                producers: [{ ...ENV_HOST_PRODUCER, hostName: "Alice's Mac" }],
              },
            ],
          }),
        ),
      ).toThrow("hostName must be null");
    });

    it("rejects a team name where the principal category belongs", () => {
      expect(() =>
        submitWithSection(sectionWith({ principal: "Acme" })),
      ).toThrow(/principal must be "personal", "team", or null/);
    });
  });

  describe("images", () => {
    it("accepts an empty images array", () => {
      const result = parseSupportSubmitReportRequest(VALID_FORM);
      expect(result.images).toEqual([]);
    });

    it("rejects a missing images key - the wire always carries it", () => {
      const { images: _images, ...withoutImages } = VALID_FORM;
      expect(() => parseSupportSubmitReportRequest(withoutImages)).toThrow();
    });

    it("rejects a non-array images value", () => {
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, images: null }),
      ).toThrow();
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, images: {} }),
      ).toThrow();
    });

    it.each([
      ["image/png", SMALL_PNG()],
      ["image/jpeg", SMALL_JPEG()],
      ["image/jpg", SMALL_JPEG()],
      ["image/gif", SMALL_GIF()],
      ["image/webp", SMALL_WEBP()],
    ] as const)("accepts a well-formed %s attachment", (mimeType, bytes) => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        images: [
          imageAttachment({
            fileName: undefined,
            mimeType,
            bytes,
          }),
        ],
      });
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mimeType).toBe(mimeType);
      expect(result.images[0]?.bytes).toBe(bytes);
    });

    it("accepts up to MAX_REPORT_IMAGES attachments", () => {
      const images = Array.from({ length: MAX_REPORT_IMAGES }, (_, i) =>
        imageAttachment({
          fileName: `shot-${i}.png`,
          mimeType: undefined,
          bytes: undefined,
        }),
      );
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        images,
      });
      expect(result.images).toHaveLength(MAX_REPORT_IMAGES);
    });

    it("rejects more than MAX_REPORT_IMAGES attachments", () => {
      const images = Array.from({ length: MAX_REPORT_IMAGES + 1 }, (_, i) =>
        imageAttachment({
          fileName: `shot-${i}.png`,
          mimeType: undefined,
          bytes: undefined,
        }),
      );
      expect(() =>
        parseSupportSubmitReportRequest({ ...VALID_FORM, images }),
      ).toThrow(/at most 3 images/);
    });

    it("rejects an attachment with an unlisted key", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [{ ...defaultImageAttachment(), extra: true }],
        }),
      ).toThrow();
    });

    it("rejects an attachment missing a required key", () => {
      const { fileName: _fileName, ...withoutName } = defaultImageAttachment();
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [withoutName],
        }),
      ).toThrow();
    });

    it("rejects a non-string fileName or mimeType", () => {
      // Build malformed payloads without type assertions: the parser takes
      // `unknown`, so a Record with the wrong runtime types is enough.
      const badFileName: Record<string, unknown> = {
        fileName: 42,
        mimeType: "image/png",
        bytes: SMALL_PNG(),
      };
      const badMimeType: Record<string, unknown> = {
        fileName: "shot.png",
        mimeType: 42,
        bytes: SMALL_PNG(),
      };
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [badFileName],
        }),
      ).toThrow();
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [badMimeType],
        }),
      ).toThrow();
    });

    it("rejects bytes that are not an ArrayBuffer instance", () => {
      const uint8Payload: Record<string, unknown> = {
        fileName: "shot.png",
        mimeType: "image/png",
        bytes: new Uint8Array(SMALL_PNG()),
      };
      const bufferPayload: Record<string, unknown> = {
        fileName: "shot.png",
        mimeType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      };
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [uint8Payload],
        }),
      ).toThrow();
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [bufferPayload],
        }),
      ).toThrow();
    });

    it("rejects an unsupported mimeType such as image/svg+xml", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: "image/svg+xml",
              bytes: SMALL_PNG(),
            }),
          ],
        }),
      ).toThrow(/image\/png, image\/jpeg, image\/jpg, image\/gif, image\/webp/);
    });

    it("rejects empty bytes", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: undefined,
              bytes: new ArrayBuffer(0),
            }),
          ],
        }),
      ).toThrow(/empty/);
    });

    it("rejects bytes larger than MAX_REPORT_IMAGE_BYTES", () => {
      const oversized = pngArrayBuffer(MAX_REPORT_IMAGE_BYTES + 1);
      expect(oversized.byteLength).toBe(MAX_REPORT_IMAGE_BYTES + 1);
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: undefined,
              bytes: oversized,
            }),
          ],
        }),
      ).toThrow(/limit/);
    });

    it("rejects magic bytes that do not match the declared media type", () => {
      // PNG magic declared as JPEG
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: "image/jpeg",
              bytes: SMALL_PNG(),
            }),
          ],
        }),
      ).toThrow(/does not match declared type/);
    });

    it("accepts three max-size images (still under the total budget)", () => {
      // Arithmetic: 3 * 5 MiB = 15_728_640; budget ceiling for images is
      // TOTAL - 2 * LOG = 20_971_520 - 1_024_000 = 19_947_520. Headroom is
      // intentional (ticket 08 / G5).
      const images = Array.from({ length: MAX_REPORT_IMAGES }, (_, i) =>
        imageAttachment({
          fileName: `max-${i}.png`,
          mimeType: undefined,
          bytes: pngArrayBuffer(MAX_REPORT_IMAGE_BYTES),
        }),
      );
      const total = images.reduce((sum, img) => sum + img.bytes.byteLength, 0);
      expect(total + 2 * REPORT_LOG_TAIL_MAX_BYTES).toBeLessThanOrEqual(
        TOTAL_ATTACHMENT_BUDGET_BYTES,
      );
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        images,
      });
      expect(result.images).toHaveLength(MAX_REPORT_IMAGES);
    });

    it("rejects a payload larger than the per-image size limit before the budget check", () => {
      // With current constants, MAX_REPORT_IMAGES * MAX_REPORT_IMAGE_BYTES
      // (15_728_640) is still under the budget ceiling
      // (TOTAL - 2*LOG = 19_947_520), so a pure budget-exceed path is not
      // reachable through valid per-image sizes. The size gate fires first
      // for any buffer large enough to threaten the total budget alone.
      // Predicate boundary coverage lives in image-attachment-guards.test.ts.
      const maxFitting =
        TOTAL_ATTACHMENT_BUDGET_BYTES - 2 * REPORT_LOG_TAIL_MAX_BYTES;
      expect(MAX_REPORT_IMAGES * MAX_REPORT_IMAGE_BYTES).toBeLessThan(
        maxFitting,
      );
      expect(maxFitting).toBeGreaterThan(MAX_REPORT_IMAGE_BYTES);
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          images: [
            imageAttachment({
              fileName: undefined,
              mimeType: undefined,
              bytes: pngArrayBuffer(maxFitting),
            }),
          ],
        }),
      ).toThrow(/limit/);
    });
  });

  // G15: mirrors the dialog's own evidence gate at the wire boundary - a
  // sentence, a screenshot, a location, or a captured error each
  // independently satisfy it; only genuinely nothing at all is rejected.
  describe("submittable-evidence gate (G15)", () => {
    it("accepts an empty intent when at least one image is attached", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        images: [defaultImageAttachment()],
      });
      expect(result.intent).toBe("");
      expect(result.images).toHaveLength(1);
    });

    it("rejects an empty intent with no images, location, or captured error", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "",
          location: null,
          images: [],
        }),
      ).toThrow(
        /requires a sentence, a screenshot, a location, or a captured error/,
      );
    });

    it("rejects an intent of only whitespace with no other evidence", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "   \n\t",
          location: null,
          images: [],
        }),
      ).toThrow();
    });

    it("accepts an empty intent when a bug location was actively changed", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        location: "Chat",
        images: [],
      });
      expect(result.intent).toBe("");
      expect(result.location).toBe("Chat");
    });

    it("rejects a blank location when no other evidence is present", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "",
          location: "  \n\t",
          images: [],
        }),
      ).toThrow(
        /requires a sentence, a screenshot, a location, or a captured error/,
      );
    });

    it("accepts an empty intent for an error-triggered report (a captured cause is its own evidence)", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        location: null,
        images: [],
        privateDiagnostics: VALID_PRIVATE_DIAGNOSTICS,
      });
      expect(result.intent).toBe("");
    });

    it("accepts an empty intent when privateDiagnostics carries only a fingerprint (no structured cause)", () => {
      const result = parseSupportSubmitReportRequest({
        ...VALID_FORM,
        intent: "",
        location: null,
        images: [],
        privateDiagnostics: {
          ...VALID_PRIVATE_DIAGNOSTICS,
          cause: null,
        },
      });
      expect(result.intent).toBe("");
    });

    it("still rejects an empty intent when privateDiagnostics has neither a cause nor a fingerprint (KB2's legacy-context shape)", () => {
      expect(() =>
        parseSupportSubmitReportRequest({
          ...VALID_FORM,
          intent: "",
          location: null,
          images: [],
          privateDiagnostics: {
            ...VALID_PRIVATE_DIAGNOSTICS,
            cause: null,
            fingerprint: null,
          },
        }),
      ).toThrow(
        /requires a sentence, a screenshot, a location, or a captured error/,
      );
    });
  });
});

describe("parseSupportReadFrozenLogTailInput", () => {
  it("accepts a well-formed input", () => {
    expect(
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "host" }),
    ).toEqual({ draftId: 1, target: "host" });
  });

  it("rejects a non-number draftId", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: "1", target: "host" }),
    ).toThrow();
  });

  it("rejects an unrecognized target instead of failing open", () => {
    // Strict rejection everywhere: an unrecognized target used to silently
    // fall back to "desktop", which is exactly the caller-discipline pattern
    // this whole contract exists to close off.
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: 1, target: "nonsense" }),
    ).toThrow();
  });

  it.each(["browserTelemetry", "browserTrace"])(
    "accepts the browser diagnostics target %s",
    (target) => {
      expect(
        parseSupportReadFrozenLogTailInput({ draftId: 1, target }),
      ).toEqual({ draftId: 1, target });
    },
  );

  it("rejects a non-integer draftId", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({ draftId: 1.5, target: "host" }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field", () => {
    expect(() =>
      parseSupportReadFrozenLogTailInput({
        draftId: 1,
        target: "host",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("parseSupportFreezeEvidenceInput", () => {
  it("accepts a well-formed input with a fingerprint", () => {
    expect(
      parseSupportFreezeEvidenceInput({
        draftId: 1,
        fingerprint: "fp:v1:abc",
      }),
    ).toEqual({ draftId: 1, fingerprint: "fp:v1:abc" });
  });

  it("accepts a null fingerprint - the manual-open / no-envelope case", () => {
    expect(
      parseSupportFreezeEvidenceInput({ draftId: 2, fingerprint: null }),
    ).toEqual({ draftId: 2, fingerprint: null });
  });

  it("rejects a missing fingerprint key - the wire always carries it", () => {
    expect(() => parseSupportFreezeEvidenceInput({ draftId: 1 })).toThrow();
  });

  it("rejects a non-integer draftId", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({
        draftId: 1.5,
        fingerprint: null,
      }),
    ).toThrow();
  });

  it("rejects a non-string non-null fingerprint", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({ draftId: 1, fingerprint: 42 }),
    ).toThrow();
  });

  it("rejects an unlisted top-level field", () => {
    expect(() =>
      parseSupportFreezeEvidenceInput({
        draftId: 1,
        fingerprint: null,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a bare draftId number - the pre-ledger shape", () => {
    expect(() => parseSupportFreezeEvidenceInput(1)).toThrow();
  });
});
