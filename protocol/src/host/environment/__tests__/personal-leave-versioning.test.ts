import { describe, expect, it } from "vitest";
import {
  type MethodVersionRegistry,
  type SchemaVersion,
} from "@traycer/protocol/framework";
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
const previewV13 = { major: 1, minor: 3 } as const;
const stopV11 = { major: 1, minor: 1 } as const;
const stopV12 = { major: 1, minor: 2 } as const;
const previewV14 = { major: 1, minor: 4 } as const;
const stopV13 = { major: 1, minor: 3 } as const;

const previewCodecRegistry: MethodVersionRegistry = previewRegistry;
const stopCodecRegistry: MethodVersionRegistry = stopRegistry;

function contractAt(registry: MethodVersionRegistry, version: SchemaVersion) {
  const contract = registry[version.major]?.versions[version.minor]?.contract;
  expect(
    contract,
    `missing registered contract ${version.major}.${version.minor}`,
  ).toBeDefined();
  if (contract === undefined) {
    throw new Error(
      `missing registered contract ${version.major}.${version.minor}`,
    );
  }
  return contract;
}

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

const digest = "a".repeat(64);
const compatibilityMatrix = [
  {
    name: "old client / old host",
    client: { preview: previewV13, stop: stopV12 },
    host: { preview: previewV13, stop: stopV12 },
  },
  {
    name: "old client / new host",
    client: { preview: previewV13, stop: stopV12 },
    host: { preview: previewV14, stop: stopV13 },
  },
  {
    name: "new client / old host",
    client: { preview: previewV14, stop: stopV13 },
    host: { preview: previewV13, stop: stopV12 },
  },
  {
    name: "new client / new host",
    client: { preview: previewV14, stop: stopV13 },
    host: { preview: previewV14, stop: stopV13 },
  },
] satisfies ReadonlyArray<{
  name: string;
  client: { preview: SchemaVersion; stop: SchemaVersion };
  host: { preview: SchemaVersion; stop: SchemaVersion };
}>;

const stopModes = [
  {
    name: "plain",
    profileMode: null,
    profileSignIns: [],
  },
  {
    name: "keep-personal",
    profileMode: "keep-personal",
    profileSignIns,
  },
] as const;

describe("environment.move Stop digest compatibility matrix", () => {
  it.each(compatibilityMatrix)("$name", (versions) => {
    for (const mode of stopModes) {
      const clientPreviewContract = contractAt(
        previewCodecRegistry,
        versions.client.preview,
      );
      const hostPreviewContract = contractAt(
        previewCodecRegistry,
        versions.host.preview,
      );
      const clientStopContract = contractAt(
        stopCodecRegistry,
        versions.client.stop,
      );
      const hostStopContract = contractAt(
        stopCodecRegistry,
        versions.host.stop,
      );

      const previewRequest = clientPreviewContract.requestSchema.parse({
        profileMode: mode.profileMode,
      });
      const preparedPreviewRequest = prepareRequestPayload(
        previewRegistry,
        versions.client.preview,
        versions.host.preview,
        previewRequest,
        `preview-${versions.client.preview.minor}-${versions.host.preview.minor}`,
        "environment.move.stopPreview",
      );
      expect(preparedPreviewRequest.onWireVersion).toEqual(
        versions.client.preview.minor <= versions.host.preview.minor
          ? versions.client.preview
          : versions.host.preview,
      );
      if (versions.client.preview.minor < versions.host.preview.minor) {
        expect(
          upgradeRequestToVersion(
            previewCodecRegistry,
            preparedPreviewRequest.onWireVersion,
            versions.host.preview,
            preparedPreviewRequest.onWirePayload,
          ),
        ).toMatchObject({ profileMode: mode.profileMode });
      }

      const stopRequestInput = {
        choices: legacyStopChoices,
        profileMode: mode.profileMode,
        profileSignIns: mode.profileSignIns,
        ...(versions.client.stop.minor === stopV13.minor
          ? { sheetDigest: digest }
          : {}),
      };
      const stopRequest =
        clientStopContract.requestSchema.parse(stopRequestInput);
      const preparedStopRequest = prepareRequestPayload(
        stopRegistry,
        versions.client.stop,
        versions.host.stop,
        stopRequest,
        `stop-${versions.client.stop.minor}-${versions.host.stop.minor}`,
        "environment.move.stop",
      );
      expect(preparedStopRequest.onWireVersion).toEqual(
        versions.client.stop.minor <= versions.host.stop.minor
          ? versions.client.stop
          : versions.host.stop,
      );

      if (versions.client.stop.minor < versions.host.stop.minor) {
        expect(
          upgradeRequestToVersion(
            stopCodecRegistry,
            preparedStopRequest.onWireVersion,
            versions.host.stop,
            preparedStopRequest.onWirePayload,
          ),
        ).toMatchObject({ sheetDigest: null });
      } else if (versions.client.stop.minor > versions.host.stop.minor) {
        expect(preparedStopRequest.onWirePayload).not.toHaveProperty(
          "sheetDigest",
        );
      } else if (versions.client.stop.minor === stopV13.minor) {
        expect(preparedStopRequest.onWirePayload).toHaveProperty(
          "sheetDigest",
          digest,
        );
      }

      const hostPreviewResponse = hostPreviewContract.responseSchema.parse({
        managed: [moveRow],
        needsChoice: previewV11Response.needsChoice,
        ...(mode.profileMode === null ? {} : { personalProfiles: null }),
        ...(versions.host.preview.minor === previewV14.minor
          ? { sheetDigest: digest }
          : {}),
      });
      const clientPreviewResponse = decodeResponsePayload<unknown>(
        previewRegistry,
        versions.client.preview,
        versions.host.preview,
        hostPreviewResponse,
        `preview-response-${versions.client.preview.minor}-${versions.host.preview.minor}`,
        "environment.move.stopPreview",
      );
      if (
        versions.host.preview.minor === previewV13.minor &&
        versions.client.preview.minor === previewV14.minor
      ) {
        expect(clientPreviewResponse).toMatchObject({ sheetDigest: null });
      }

      const hostStopResponse = hostStopContract.responseSchema.parse({
        outcome: "stopped",
        profileResults: [],
      });
      const clientStopResponse = decodeResponsePayload<unknown>(
        stopRegistry,
        versions.client.stop,
        versions.host.stop,
        hostStopResponse,
        `stop-response-${versions.client.stop.minor}-${versions.host.stop.minor}`,
        "environment.move.stop",
      );
      expect(clientStopResponse).toMatchObject({ outcome: "stopped" });

      if (
        versions.client.stop.minor === stopV13.minor &&
        versions.host.stop.minor === stopV13.minor
      ) {
        const freshPreview = {
          managed: [moveRow],
          needsChoice: previewV11Response.needsChoice,
          ...(mode.profileMode === null ? {} : { personalProfiles: null }),
          sheetDigest: digest,
        };
        const changedResponse = hostStopContract.responseSchema.parse({
          outcome: "sheet_changed",
          preview: freshPreview,
        });
        expect(
          decodeResponsePayload<unknown>(
            stopRegistry,
            versions.client.stop,
            versions.host.stop,
            changedResponse,
            `changed-response-${mode.name}`,
            "environment.move.stop",
          ),
        ).toEqual(changedResponse);
      }
    }
  });

  it("keeps sheet_changed out of the released preview/stop versions", () => {
    const legacyStop = contractAt(stopCodecRegistry, stopV12);
    expect(
      legacyStop.responseSchema.safeParse({
        outcome: "sheet_changed",
        preview: { managed: [], needsChoice: [] },
      }).success,
    ).toBe(false);
  });

  it("requires a valid digest on current previews and only on changed previews", () => {
    const previewContract = contractAt(previewCodecRegistry, previewV14);
    const stopContract = contractAt(stopCodecRegistry, stopV13);
    const previewWithoutDigest = { managed: [], needsChoice: [] };

    expect(
      previewContract.responseSchema.safeParse(previewWithoutDigest).success,
    ).toBe(false);
    expect(
      previewContract.responseSchema.safeParse({
        ...previewWithoutDigest,
        sheetDigest: "not-a-sha256",
      }).success,
    ).toBe(false);
    expect(
      previewContract.responseSchema.parse({
        ...previewWithoutDigest,
        sheetDigest: null,
      }),
    ).toMatchObject({ sheetDigest: null });

    expect(
      stopContract.requestSchema.parse({ choices: [], profileMode: null }),
    ).toMatchObject({ sheetDigest: null });
    expect(
      stopContract.requestSchema.safeParse({
        choices: [],
        profileMode: null,
        sheetDigest: "not-a-sha256",
      }).success,
    ).toBe(false);
    expect(
      stopContract.responseSchema.safeParse({
        outcome: "sheet_changed",
        preview: { ...previewWithoutDigest, sheetDigest: null },
      }).success,
    ).toBe(false);
  });
});

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

const sharedRows = [
  {
    providerId: "claude-code",
    profileId: "shared-row",
    label: "Shared account",
    signIn: "offered",
    shared: true,
  },
  {
    providerId: "claude-code",
    profileId: "own-row",
    label: "Own account",
    signIn: "offered",
    shared: false,
  },
  {
    providerId: "claude-code",
    profileId: "api-key-row",
    label: "API key",
    signIn: "not-needed",
    shared: true,
  },
] as const;

const withoutShared = sharedRows.map(({ shared: _shared, ...row }) => row);

const mixedSignIns = [
  { providerId: "claude-code", profileId: "pressed", signIn: { kind: "skip" } },
  {
    providerId: "claude-code",
    profileId: "answered",
    signIn: { kind: "signed-in", admissionId: "held-admission-fixture" },
  },
  {
    providerId: "claude-code",
    profileId: "left-alone",
    signIn: { kind: "untouched" },
  },
] as const;

describe("environment.move stopPreview@1.3 marks a shared folder", () => {
  it("keeps 1.3 installed and names 1.5 the latest preview", () => {
    expect(previewRegistry[1].latestMinor).toBe(5);
    expect(previewRegistry[1].versions[3].contract.schemaVersion).toEqual(
      previewV13,
    );
    expect(previewRegistry[1].versions[4].contract.schemaVersion).toEqual(
      previewV14,
    );
  });

  it("carries shared on every personal profile row, and requires it", () => {
    const schema = previewRegistry[1].versions[3].contract.responseSchema;
    expect(
      schema.parse({
        managed: [],
        needsChoice: [],
        personalProfiles: sharedRows,
      }).personalProfiles,
    ).toEqual(sharedRows);
    expect(
      schema.safeParse({
        managed: [],
        needsChoice: [],
        personalProfiles: withoutShared,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        managed: [],
        needsChoice: [],
        personalProfiles: [{ ...sharedRows[0], shared: "yes" }],
      }).success,
    ).toBe(false);
  });

  it("answers shared: false on every row of a 1.2 host's preview, so no row is ever offered as removable", () => {
    const decoded = decodeResponsePayload<{
      readonly personalProfiles?: readonly object[] | null;
    }>(
      previewRegistry,
      previewV13,
      previewV12,
      { managed: [], needsChoice: [], personalProfiles: withoutShared },
      "preview-response-fixture",
      "environment.move.stopPreview",
    );
    expect(decoded.personalProfiles).toEqual(
      withoutShared.map((row) => ({ ...row, shared: false })),
    );
  });

  it.each([
    ["null", null],
    ["omitted", undefined],
    ["empty", []],
  ])(
    "keeps a 1.2 host's %s personal profiles as they were",
    (_name, personalProfiles) => {
      const decoded = decodeResponsePayload<{
        readonly personalProfiles?: readonly object[] | null;
      }>(
        previewRegistry,
        previewV13,
        previewV12,
        {
          managed: [],
          needsChoice: [],
          ...(personalProfiles === undefined ? {} : { personalProfiles }),
        },
        "preview-response-fixture",
        "environment.move.stopPreview",
      );
      expect(decoded.personalProfiles).toEqual(personalProfiles);
    },
  );

  it("answers a 1.1 host's preview with no personal profiles at all", () => {
    const decoded = decodeResponsePayload<{
      readonly personalProfiles?: readonly object[] | null;
    }>(
      previewRegistry,
      previewV13,
      { major: 1, minor: 1 },
      previewV11Response,
      "preview-response-fixture",
      "environment.move.stopPreview",
    );
    expect(decoded.personalProfiles).toBeNull();
  });

  it("serves a 1.2 client the same rows without shared", () => {
    expect(
      previewRegistry[1].versions[2].contract.responseSchema.parse({
        managed: [],
        needsChoice: [],
        personalProfiles: sharedRows,
      }).personalProfiles,
    ).toEqual(withoutShared);
  });
});

describe("environment.move stop@1.2 tells a pressed Skip from an untouched row", () => {
  it("keeps 1.2 installed and names 1.4 the latest stop", () => {
    expect(stopRegistry[1].latestMinor).toBe(4);
    expect(stopRegistry[1].versions[2].contract.schemaVersion).toEqual(stopV12);
    expect(stopRegistry[1].versions[3].contract.schemaVersion).toEqual(stopV13);
  });

  it("accepts skip, untouched and signed-in in one request", () => {
    const parsed = stopRegistry[1].versions[2].contract.requestSchema.parse({
      choices: legacyStopChoices,
      profileMode: "keep-personal",
      profileSignIns: mixedSignIns,
    });
    expect(parsed.profileSignIns).toEqual(mixedSignIns);
  });

  it("refuses a choice kind it does not know", () => {
    expect(
      stopRegistry[1].versions[2].contract.requestSchema.safeParse({
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "claude-code",
            profileId: "p",
            signIn: { kind: "remove" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("does not let a 1.1 request carry untouched", () => {
    expect(
      stopRegistry[1].versions[1].contract.requestSchema.safeParse({
        choices: [],
        profileMode: "keep-personal",
        profileSignIns: [
          {
            providerId: "claude-code",
            profileId: "p",
            signIn: { kind: "untouched" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("reads every skip a 1.1 client sent as untouched, so an older client never causes a removal", () => {
    const request = stopRegistry[1].versions[1].contract.requestSchema.parse({
      choices: legacyStopChoices,
      profileMode: "keep-personal",
      profileSignIns: [mixedSignIns[0], mixedSignIns[1]],
    });
    expect(
      upgradeRequestToVersion(stopRegistry, stopV11, stopV12, request),
    ).toEqual({
      choices: legacyStopChoices,
      profileMode: "keep-personal",
      profileSignIns: [
        {
          providerId: "claude-code",
          profileId: "pressed",
          signIn: { kind: "untouched" },
        },
        mixedSignIns[1],
      ],
    });
  });

  it("reads a 1.0 client's stop as one with no choice at all", () => {
    const request = stopRegistry[1].versions[0].contract.requestSchema.parse({
      choices: legacyStopChoices,
    });
    expect(
      upgradeRequestToVersion(
        stopRegistry,
        { major: 1, minor: 0 },
        stopV12,
        request,
      ),
    ).toEqual({
      choices: legacyStopChoices,
      profileMode: null,
      profileSignIns: [],
    });
  });

  it("answers a 1.1 host's stop like a 1.2 host's", () => {
    expect(
      decodeResponsePayload<EnvironmentMoveStopResponseV11>(
        stopRegistry,
        stopV12,
        stopV11,
        { outcome: "stopped", profileResults },
        "stop-response-fixture",
        "environment.move.stop",
      ),
    ).toEqual({ outcome: "stopped", profileResults });
  });
});

describe("guarded Stop preserves the ordinary digest wire contracts", () => {
  const guardedPreview = { major: 1, minor: 5 };
  const guardedStop = { major: 1, minor: 4 };
  const personalBinding = {
    environmentId: "env_01JA000000000000000000000A",
    bindingGeneration: 1,
    sharingGeneration: 4,
  };
  const ordinaryPreview = {
    ...previewV12Response,
    personalProfiles: null,
    sheetDigest: "01".repeat(32),
  };
  const ordinaryStop = {
    choices: legacyStopChoices,
    profileMode: null,
    profileSignIns: [],
    sheetDigest: ordinaryPreview.sheetDigest,
  };

  it("upgrades an ordinary digest preview without inventing binding authority", () => {
    const old = contractAt(previewCodecRegistry, previewV14);
    expect(old.responseSchema.parse(ordinaryPreview)).toEqual(ordinaryPreview);
    expect(
      decodeResponsePayload(
        previewCodecRegistry,
        guardedPreview,
        previewV14,
        ordinaryPreview,
        "stop-preview-digest",
        "environment.move.stopPreview",
      ),
    ).toEqual({
      ...ordinaryPreview,
      ownershipUnreadable: false,
      personalBinding: null,
    });
  });

  it("requires new request authority fields and retains the digest on recovery", () => {
    const preview = contractAt(previewCodecRegistry, guardedPreview);
    expect(preview.requestSchema.safeParse({ profileMode: null }).success).toBe(
      false,
    );
    expect(
      preview.responseSchema.parse({
        ...ordinaryPreview,
        ownershipUnreadable: false,
        personalBinding,
      }),
    ).toEqual({
      ...ordinaryPreview,
      ownershipUnreadable: false,
      personalBinding,
    });

    const stop = contractAt(stopCodecRegistry, guardedStop);
    expect(stop.requestSchema.safeParse(ordinaryStop).success).toBe(false);
    expect(
      stop.requestSchema.parse({
        ...ordinaryStop,
        expectedPersonalBinding: personalBinding,
        requireUnreadableOwnership: false,
      }),
    ).toEqual({
      ...ordinaryStop,
      expectedPersonalBinding: personalBinding,
      requireUnreadableOwnership: false,
    });
  });

  it("keeps a digest-bearing older confirmation's sheet_changed response", () => {
    const stop = contractAt(stopCodecRegistry, stopV13);
    const changed = { outcome: "sheet_changed", preview: ordinaryPreview };
    expect(stop.requestSchema.parse(ordinaryStop)).toEqual(ordinaryStop);
    expect(stop.responseSchema.parse(changed)).toEqual(changed);
    expect(
      decodeResponsePayload(
        stopCodecRegistry,
        guardedStop,
        stopV13,
        changed,
        "stop-confirm-digest",
        "environment.move.stop",
      ),
    ).toEqual(changed);
  });
});
