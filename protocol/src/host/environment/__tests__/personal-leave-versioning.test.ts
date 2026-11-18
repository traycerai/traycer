import { describe, expect, it } from "vitest";
import { upgradeRequestToVersion } from "@traycer/protocol/framework/versioned-rpc";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  decodeResponsePayload,
  prepareRequestPayload,
} from "@traycer/protocol/host-transport/remote/rpc-codec";
import {
  environmentMoveStopPreviewRequestSchema,
  environmentMoveStopPreviewResponseSchema,
  environmentMoveStopPreviewResponseSchemaV11,
  environmentMoveStopRequestSchema,
  environmentMoveStopResponseSchema,
  type EnvironmentMoveStopPreviewRequestV12,
  type EnvironmentMoveStopPreviewResponseV12,
  type EnvironmentMoveStopRequestV11,
  type EnvironmentMoveStopResponseV11,
} from "@traycer/protocol/host/environment/move-contracts";

const previewRegistry = hostRpcRegistry["environment.move.stopPreview"];
const stopRegistry = hostRpcRegistry["environment.move.stop"];
const previewV12 = { major: 1, minor: 2 } as const;
const stopV11 = { major: 1, minor: 1 } as const;

type PreviewMinor = 0 | 1;

const moveRow = {
  kind: "variable",
  key: "AUTO_SAVE",
  os: "any",
  label: "AUTO_SAVE",
  detail: null,
} as const;
const changedRow = {
  ...moveRow,
  key: "LOG_LEVEL",
  label: "LOG_LEVEL",
} as const;
const dependentRow = {
  ...moveRow,
  key: "EDITOR",
  label: "EDITOR",
} as const;
const usedByRow = {
  ...moveRow,
  key: "FORMATTER",
  label: "FORMATTER",
} as const;

const legacyStopChoices: EnvironmentMoveStopRequestV11["choices"] = [
  { kind: "variable", key: "LOG_LEVEL", choice: "keep_locally" },
  {
    kind: "variable",
    key: "EDITOR",
    choice: "remove_from_this_computer",
  },
];

const profileSignIns = [
  {
    providerId: "codex",
    profileId: "profile-row-id",
    signIn: { kind: "skip" },
  },
  {
    providerId: "codex",
    profileId: "folder-alias-id",
    signIn: { kind: "signed-in", admissionId: "held-admission-fixture" },
  },
] as const;

const previewV10Response = {
  managed: [moveRow],
  needsChoice: [
    { row: changedRow, reason: "edited_here" },
    { row: dependentRow, reason: "depended_on" },
  ],
} as const;

const previewV11Response = {
  managed: [moveRow],
  needsChoice: [
    {
      row: changedRow,
      reason: "edited_here",
      origin: "changed_here",
      usedBy: [],
    },
    {
      row: dependentRow,
      reason: "depended_on",
      origin: "depended_on",
      usedBy: [usedByRow],
    },
    {
      row: { ...moveRow, key: "MIGRATED", label: "MIGRATED" },
      reason: "edited_here",
      origin: "from_this_computer",
      usedBy: [],
    },
  ],
} as const;

const previewV12Response = {
  managed: [moveRow],
  needsChoice: previewV11Response.needsChoice,
  personalProfiles: [
    {
      providerId: "codex",
      profileId: "profile-row-id",
      label: "Work",
      signIn: "offered",
    },
    {
      providerId: "codex",
      profileId: "folder-alias-id",
      label: "Work alias",
      signIn: "not-needed",
    },
  ],
} as const;

function upgradePreviewRequest(
  minor: PreviewMinor,
  input: unknown,
): EnvironmentMoveStopPreviewRequestV12 {
  switch (minor) {
    case 0:
      return upgradeRequestToVersion(
        previewRegistry,
        { major: 1, minor: 0 },
        previewV12,
        previewRegistry[1].versions[0].contract.requestSchema.parse(input),
      );
    case 1:
      return upgradeRequestToVersion(
        previewRegistry,
        { major: 1, minor: 1 },
        previewV12,
        previewRegistry[1].versions[1].contract.requestSchema.parse(input),
      );
  }
}

const previewRequestUpCases = [
  {
    name: "environment.move.stopPreview@1.0 request older client -> new host",
    minor: 0,
    input: {},
    expected: { profileMode: null },
  },
  {
    name: "environment.move.stopPreview@1.1 request older client -> new host",
    minor: 1,
    input: {},
    expected: { profileMode: null },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: PreviewMinor;
  input: unknown;
  expected: EnvironmentMoveStopPreviewRequestV12;
}>;

const previewRequestDownCases = [
  {
    name: "environment.move.stopPreview@1.1 request new client -> older host (projection)",
    minor: 1,
    expected: {},
  },
  {
    name: "environment.move.stopPreview@1.0 request new client -> older host (projection)",
    minor: 0,
    expected: {},
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: PreviewMinor;
  expected: unknown;
}>;

const previewResponseUpCases = [
  {
    name: "environment.move.stopPreview@1.0 response older host -> new client",
    minor: 0,
    input: previewV10Response,
    expected: {
      managed: [moveRow],
      needsChoice: [
        {
          row: changedRow,
          reason: "edited_here",
          origin: "changed_here",
          usedBy: [],
        },
        {
          row: dependentRow,
          reason: "depended_on",
          origin: "depended_on",
          usedBy: [],
        },
      ],
      personalProfiles: null,
    },
  },
  {
    name: "environment.move.stopPreview@1.1 response older host -> new client",
    minor: 1,
    input: previewV11Response,
    expected: {
      managed: [moveRow],
      needsChoice: [
        {
          row: changedRow,
          reason: "edited_here",
          origin: "changed_here",
          usedBy: [],
        },
        {
          row: dependentRow,
          reason: "depended_on",
          origin: "depended_on",
          usedBy: [usedByRow],
        },
        {
          row: { ...moveRow, key: "MIGRATED", label: "MIGRATED" },
          reason: "edited_here",
          origin: "from_this_computer",
          usedBy: [],
        },
      ],
      personalProfiles: null,
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: PreviewMinor;
  input: unknown;
  expected: EnvironmentMoveStopPreviewResponseV12;
}>;

const previewResponseDownCases = [
  {
    name: "environment.move.stopPreview@1.1 response new host -> older client",
    minor: 1,
    expected: {
      managed: [moveRow],
      needsChoice: previewV11Response.needsChoice,
    },
  },
  {
    name: "environment.move.stopPreview@1.0 response new host -> older client",
    minor: 0,
    expected: {
      managed: [moveRow],
      needsChoice: [
        { row: changedRow, reason: "edited_here" },
        { row: dependentRow, reason: "depended_on" },
        {
          row: { ...moveRow, key: "MIGRATED", label: "MIGRATED" },
          reason: "edited_here",
        },
      ],
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  minor: PreviewMinor;
  expected: unknown;
}>;

const stopRequestUpCases = [
  {
    name: "environment.move.stop@1.0 request older client -> new host",
    input: { choices: legacyStopChoices },
    expected: {
      choices: legacyStopChoices,
      profileMode: null,
      profileSignIns: [],
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  input: unknown;
  expected: EnvironmentMoveStopRequestV11;
}>;

const stopRequestDownCases = [
  {
    name: "environment.move.stop@1.0 request new client -> older host (projection)",
    input: {
      choices: legacyStopChoices,
      profileMode: "keep-personal",
      profileSignIns,
    },
    expected: { choices: legacyStopChoices },
  },
] satisfies ReadonlyArray<{
  name: string;
  input: unknown;
  expected: unknown;
}>;

const stopResponseUpCases = [
  {
    name: "environment.move.stop@1.0 response older host -> new client",
    input: { outcome: "stopped" },
    expected: { outcome: "stopped", profileResults: null },
  },
] satisfies ReadonlyArray<{
  name: string;
  input: unknown;
  expected: EnvironmentMoveStopResponseV11;
}>;

const stopResponseDownCases = [
  {
    name: "environment.move.stop@1.0 response new host -> older client",
    expected: { outcome: "stopped" },
  },
] satisfies ReadonlyArray<{
  name: string;
  expected: unknown;
}>;

const profileResults = [
  { providerId: "codex", profileId: "profile-a", signIn: "not-needed" },
  { providerId: "codex", profileId: "profile-b", signIn: "skipped" },
  { providerId: "codex", profileId: "profile-c", signIn: "installed" },
  {
    providerId: "codex",
    profileId: "profile-d",
    signIn: "installation-pending",
  },
  {
    providerId: "codex",
    profileId: "profile-e",
    signIn: "sign-in-unavailable",
  },
  {
    providerId: "codex",
    profileId: "folder-alias-id",
    signIn: "installation-failed",
  },
] as const;

describe("environment.move personal leave compatibility", () => {
  it.each(previewRequestUpCases)("$name", (testCase) => {
    expect(upgradePreviewRequest(testCase.minor, testCase.input)).toEqual(
      testCase.expected,
    );
  });

  it.each(previewRequestDownCases)("$name", (testCase) => {
    const request = previewRegistry[1].versions[2].contract.requestSchema.parse(
      { profileMode: "keep-personal" },
    );
    expect(
      prepareRequestPayload(
        previewRegistry,
        previewV12,
        { major: 1, minor: testCase.minor },
        request,
        "preview-request-fixture",
        "environment.move.stopPreview",
      ),
    ).toEqual({
      onWireVersion: { major: 1, minor: testCase.minor },
      onWirePayload: testCase.expected,
    });
  });

  it.each(previewResponseUpCases)("$name", (testCase) => {
    expect(
      decodeResponsePayload<EnvironmentMoveStopPreviewResponseV12>(
        previewRegistry,
        previewV12,
        { major: 1, minor: testCase.minor },
        testCase.input,
        "preview-response-fixture",
        "environment.move.stopPreview",
      ),
    ).toEqual(testCase.expected);
  });

  it.each(previewResponseDownCases)("$name", (testCase) => {
    expect(
      previewRegistry[1].versions[testCase.minor].contract.responseSchema.parse(
        previewV12Response,
      ),
    ).toEqual(testCase.expected);
  });

  it("preserves the distinction between omitted, null, empty, and populated personal profiles", () => {
    const responseSchema =
      previewRegistry[1].versions[2].contract.responseSchema;
    const omitted = responseSchema.parse({ managed: [], needsChoice: [] });
    expect(omitted).toEqual({ managed: [], needsChoice: [] });
    expect(
      responseSchema.parse({
        managed: [],
        needsChoice: [],
        personalProfiles: null,
      }),
    ).toEqual({ managed: [], needsChoice: [], personalProfiles: null });
    expect(
      responseSchema.parse({
        managed: [],
        needsChoice: [],
        personalProfiles: [],
      }),
    ).toEqual({ managed: [], needsChoice: [], personalProfiles: [] });
    expect(responseSchema.parse(previewV12Response).personalProfiles).toEqual([
      {
        providerId: "codex",
        profileId: "profile-row-id",
        label: "Work",
        signIn: "offered",
      },
      {
        providerId: "codex",
        profileId: "folder-alias-id",
        label: "Work alias",
        signIn: "not-needed",
      },
    ]);
  });

  it("retains the released preview schema factories on their exact registry lines", () => {
    expect(previewRegistry[1].versions[0].contract.requestSchema).toBe(
      environmentMoveStopPreviewRequestSchema,
    );
    expect(previewRegistry[1].versions[0].contract.responseSchema).toBe(
      environmentMoveStopPreviewResponseSchema,
    );
    expect(previewRegistry[1].versions[1].contract.requestSchema).toBe(
      environmentMoveStopPreviewRequestSchema,
    );
    expect(previewRegistry[1].versions[1].contract.responseSchema).toBe(
      environmentMoveStopPreviewResponseSchemaV11,
    );
  });

  it("rejects malformed latest preview modes and stop profile choices", () => {
    const previewRequestSchema =
      previewRegistry[1].versions[2].contract.requestSchema;
    expect(previewRequestSchema.parse({})).toEqual({ profileMode: null });
    expect(
      previewRequestSchema.safeParse({ profileMode: "legacy-stop" }).success,
    ).toBe(false);

    const stopRequestSchema =
      stopRegistry[1].versions[1].contract.requestSchema;
    expect(stopRequestSchema.parse({ choices: legacyStopChoices })).toEqual({
      choices: legacyStopChoices,
      profileMode: null,
      profileSignIns: [],
    });
    expect(
      stopRequestSchema.parse({
        choices: legacyStopChoices,
        profileMode: "keep-personal",
        profileSignIns,
      }),
    ).toEqual({
      choices: legacyStopChoices,
      profileMode: "keep-personal",
      profileSignIns,
    });
    expect(
      stopRequestSchema.safeParse({
        choices: legacyStopChoices,
        profileMode: "legacy-stop",
        profileSignIns,
      }).success,
    ).toBe(false);
    expect(
      stopRequestSchema.safeParse({
        choices: legacyStopChoices,
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "codex",
            profileId: "folder-row-id",
            signIn: { kind: "signed-in", admissionId: "" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each(stopRequestUpCases)("$name", (testCase) => {
    const request = stopRegistry[1].versions[0].contract.requestSchema.parse(
      testCase.input,
    );
    expect(
      upgradeRequestToVersion(
        stopRegistry,
        { major: 1, minor: 0 },
        stopV11,
        request,
      ),
    ).toEqual(testCase.expected);
  });

  it.each(stopRequestDownCases)("$name", (testCase) => {
    const request = stopRegistry[1].versions[1].contract.requestSchema.parse(
      testCase.input,
    );
    expect(
      prepareRequestPayload(
        stopRegistry,
        stopV11,
        { major: 1, minor: 0 },
        request,
        "stop-request-fixture",
        "environment.move.stop",
      ),
    ).toEqual({
      onWireVersion: { major: 1, minor: 0 },
      onWirePayload: testCase.expected,
    });
  });

  it.each(stopResponseUpCases)("$name", (testCase) => {
    expect(
      decodeResponsePayload<EnvironmentMoveStopResponseV11>(
        stopRegistry,
        stopV11,
        { major: 1, minor: 0 },
        testCase.input,
        "stop-response-fixture",
        "environment.move.stop",
      ),
    ).toEqual(testCase.expected);
  });

  it.each(stopResponseDownCases)("$name", (testCase) => {
    const response = stopRegistry[1].versions[1].contract.responseSchema.parse({
      outcome: "stopped",
      profileResults,
    });
    expect(
      stopRegistry[1].versions[0].contract.responseSchema.parse(response),
    ).toEqual(testCase.expected);
  });

  it("preserves the distinction between omitted, null, empty, and all six profile results", () => {
    const responseSchema = stopRegistry[1].versions[1].contract.responseSchema;
    const omitted = responseSchema.parse({ outcome: "stopped" });
    expect(omitted).toEqual({ outcome: "stopped" });
    expect(
      responseSchema.parse({ outcome: "stopped", profileResults: null }),
    ).toEqual({ outcome: "stopped", profileResults: null });
    expect(
      responseSchema.parse({ outcome: "stopped", profileResults: [] }),
    ).toEqual({ outcome: "stopped", profileResults: [] });
    expect(
      responseSchema.parse({ outcome: "stopped", profileResults }),
    ).toEqual({ outcome: "stopped", profileResults });
  });

  it("retains the released stop schema factories on their exact registry line", () => {
    expect(stopRegistry[1].versions[0].contract.requestSchema).toBe(
      environmentMoveStopRequestSchema,
    );
    expect(stopRegistry[1].versions[0].contract.responseSchema).toBe(
      environmentMoveStopResponseSchema,
    );
  });
});
