import type { TransportVantage } from "../../host-transport/vantage";
import {
  hostInstallRecordSchema,
  hostInstallRecordWireV10Schema,
  hostStagedRecordSchema,
  hostStagedRecordWireV10Schema,
  storedCliInstallManifestSchema,
  // The browser-safe half deliberately: this module is on the RPC registry the
  // renderer imports, and `./installation` also carries the Node-only readers.
} from "@traycer/protocol/config/installation-records";
import { z } from "zod";

const emptyRequestSchema = z.object({});

/**
 * The CLI doctor report is intentionally represented structurally here rather than importing CLI-owned issue-code constants into protocol.
 */
export const hostDoctorIssueSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error", "fatal"]),
  title: z.string(),
  message: z.string(),
  fixAction: z.string().nullable(),
  terminalCommand: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type HostDoctorIssue = z.infer<typeof hostDoctorIssueSchema>;

export const hostDoctorRequestSchema = emptyRequestSchema;
export type HostDoctorRequest = z.infer<typeof hostDoctorRequestSchema>;

export const hostDoctorResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    issues: z.array(hostDoctorIssueSchema),
    triviallyGreenIssueCodes: z.array(z.string()),
  }),
  z.object({ status: z.literal("cli-unavailable") }),
  z.object({ status: z.literal("cli-failed") }),
  z.object({ status: z.literal("invalid-output") }),
]);
export type HostDoctorResponse = z.infer<typeof hostDoctorResponseSchema>;

export const LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES = [
  "SERVICE_STOPPED",
  "PORT_UNREACHABLE",
  "PORT_CONFLICT",
] as const;

/** No code is universally proven: a relay-served RPC gets this empty set. */
export const RPC_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES = [] as const;

/**
 * The host can only caption doctor issues as trivially green when this RPC arrived over a direct local WebSocket.
 */
export function doctorTriviallyGreenIssueCodesForVantage(
  vantage: TransportVantage,
): readonly string[] {
  return vantage === "local-ws"
    ? LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES
    : RPC_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES;
}

/** Only `https:` and `http:`. */
const httpAssetUrlSchema = z
  .string()
  .refine(
    (value) =>
      URL.canParse(value) &&
      (new URL(value).protocol === "https:" ||
        new URL(value).protocol === "http:"),
    { message: "must be an http(s) URL" },
  );

/**
 * The two arms are genuinely different records, not one record with optional fields.
 * Both arms keep `unavailableReason` nullable, since an available asset may still carry a note.
 */
const hostPlatformAssetSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    unavailableReason: z.string().nullable(),
    url: httpAssetUrlSchema,
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    signatureUrl: httpAssetUrlSchema,
    signatureAlgorithm: z.literal("minisign"),
    publicKeyId: z.string().min(1),
  }),
  z.object({
    available: z.literal(false),
    unavailableReason: z.string().nullable(),
    url: z.string(),
    sizeBytes: z.number().finite(),
    sha256: z.string(),
    signatureUrl: z.string(),
    signatureAlgorithm: z.literal("minisign"),
    publicKeyId: z.string(),
  }),
]);

export const hostAvailableManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  latest: z.string(),
  versions: z.array(
    z.object({
      version: z.string(),
      releasedAt: z.string(),
      releaseNotesUrl: z.string(),
      yanked: z.boolean(),
      deprecationReason: z.string().nullable(),
      requiredCliVersion: z.string().nullable(),
      // The CLI projects this map to its platform before emitting it.
      platforms: z.record(z.string(), hostPlatformAssetSchema),
    }),
  ),
});
export type HostAvailableManifest = z.infer<typeof hostAvailableManifestSchema>;

/** Whether the answer should include release candidates. */
export const hostUpdateCheckRequestSchema = z.object({
  includePreReleases: z.boolean().default(false),
});
export type HostUpdateCheckRequest = z.infer<
  typeof hostUpdateCheckRequestSchema
>;

export const hostUpdateCheckResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), manifest: hostAvailableManifestSchema }),
  z.object({ outcome: z.literal("cli-unavailable") }),
  z.object({ outcome: z.literal("cli-failed") }),
  z.object({ outcome: z.literal("invalid-output") }),
]);
export type HostUpdateCheckResponse = z.infer<
  typeof hostUpdateCheckResponseSchema
>;

/**
 * Where the catalog's effective RC inclusion came from.
 * They exist because "unchecked" and "never touched" are genuinely different requests: only an explicit false can filter RC rows off an RC host.
 */
export const hostIncludePreReleasesSourceSchema = z.enum([
  "explicit-include",
  "explicit-exclude",
  "installed-rc",
  "stable-default",
]);
export type HostIncludePreReleasesSource = z.infer<
  typeof hostIncludePreReleasesSourceSchema
>;

/**
 * v1.1 replaces v1.0's defaulted boolean with a tri-state catalog override: `true` explicitly includes, `false` explicitly excludes, and ABSENT asks the host to derive inclusion from its own installed version.
 * The two ways a derive request reaches a resolver do not agree on key PRESENCE, only on VALUE
 */
export const hostUpdateCheckRequestSchemaV11 = z.object({
  includePreReleases: z.boolean().optional(),
});
export type HostUpdateCheckRequestV11 = z.infer<
  typeof hostUpdateCheckRequestSchemaV11
>;

/**
 * v1.1's `ok` arm reports what the catalog actually did.
 * The other three outcomes are unchanged; a CLI that never ran resolved nothing to report.
 */
export const hostUpdateCheckResponseSchemaV11 = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("ok"),
      manifest: hostAvailableManifestSchema,
      effectiveIncludePreReleases: z.boolean(),
      includePreReleasesSource: hostIncludePreReleasesSourceSchema,
    }),
    z.object({ outcome: z.literal("cli-unavailable") }),
    z.object({ outcome: z.literal("cli-failed") }),
    z.object({ outcome: z.literal("invalid-output") }),
  ],
);
export type HostUpdateCheckResponseV11 = z.infer<
  typeof hostUpdateCheckResponseSchemaV11
>;

export const hostUpdateInstallRequestSchema = z.object({
  version: z.string().min(1),
  force: z.boolean(),
});
export type HostUpdateInstallRequest = z.infer<
  typeof hostUpdateInstallRequestSchema
>;

/** `already-updating` means an update this host started is still running, so this one was not. */
export const hostUpdateInstallResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({ outcome: z.literal("externally-managed") }),
  z.object({ outcome: z.literal("cli-unavailable") }),
  z.object({ outcome: z.literal("cli-failed") }),
  z.object({ outcome: z.literal("already-updating") }),
]);
export type HostUpdateInstallResponse = z.infer<
  typeof hostUpdateInstallResponseSchema
>;

/**
 * `@1.1` adds `attemptId` to the two arms for which a durable schema-v2 update attempt can be a fact.
 * Do NOT add the key for symmetry with its neighbours.
 */
export const hostUpdateInstallResponseV11Schema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("accepted"),
      attemptId: z.string().min(1).nullable(),
    }),
    z.object({ outcome: z.literal("externally-managed") }),
    z.object({ outcome: z.literal("cli-unavailable") }),
    z.object({ outcome: z.literal("cli-failed") }),
    z.object({
      outcome: z.literal("already-updating"),
      attemptId: z.string().min(1).nullable(),
    }),
    // No `attemptId` key. See the asymmetry note above before adding one.
    z.object({
      outcome: z.literal("dispatch-indeterminate"),
      reason: z.string().min(1).nullable(),
    }),
  ],
);
export type HostUpdateInstallResponseV11 = z.infer<
  typeof hostUpdateInstallResponseV11Schema
>;

export const hostGetInstallationInfoRequestSchema = emptyRequestSchema;
export type HostGetInstallationInfoRequest = z.infer<
  typeof hostGetInstallationInfoRequestSchema
>;

/**
 * `@1.0` - the FROZEN released line, and it must stay byte-shaped as shipped.
 * The `@1.0` slot is therefore served from the frozen WIRE projections.
 */
export const hostGetInstallationInfoResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("unmanaged") }),
    z.object({
      status: z.literal("managed"),
      installRecord: hostInstallRecordWireV10Schema,
      stagedRecord: hostStagedRecordWireV10Schema.nullable(),
      cliManifest: storedCliInstallManifestSchema.nullable(),
    }),
  ],
);
export type HostGetInstallationInfoResponse = z.infer<
  typeof hostGetInstallationInfoResponseSchema
>;

/**
 * `@1.1` - the same call, additionally carrying `executableSha256` on both records.
 * A MINOR, not a major: the growth is additive, host→client, and every consumer already tolerates absence because old hosts never sent it (the record schemas normalize a missing value to `null` by construction).
 */
export const hostGetInstallationInfoResponseV11Schema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("unmanaged") }),
    z.object({
      status: z.literal("managed"),
      installRecord: hostInstallRecordSchema,
      stagedRecord: hostStagedRecordSchema.nullable(),
      cliManifest: storedCliInstallManifestSchema.nullable(),
    }),
  ],
);
export type HostGetInstallationInfoResponseV11 = z.infer<
  typeof hostGetInstallationInfoResponseV11Schema
>;

/** The OS service registration, over RPC rather than only the local CLI bridge. */
/**
 * `externally-managed` is the CLI's word for a registration that EXISTS but is not the CLI's to touch - on macOS, the label loaded from Traycer Desktop's SMAppService in-bundle plist.
 * A caller must render it as "registered, owned elsewhere" and withhold the CLI-backed mutations.
 */
export const hostServiceStateSchema = z.enum([
  "running",
  "stopped",
  "not-installed",
  "externally-managed",
]);
export type HostServiceState = z.infer<typeof hostServiceStateSchema>;

export const hostServiceStatusRequestSchema = emptyRequestSchema;
export type HostServiceStatusRequest = z.infer<
  typeof hostServiceStatusRequestSchema
>;

export const hostServiceStatusResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    state: hostServiceStateSchema,
    /** The service label (`ai.traycer.host`, …) - identity, not decoration. */
    label: z.string().min(1),
    /** The plist / unit / scheduled-task path the registration lives at. */
    manifestPath: z.string().min(1),
  }),
  z.object({ outcome: z.literal("externally-managed") }),
  z.object({ outcome: z.literal("cli-unavailable") }),
  z.object({ outcome: z.literal("cli-failed") }),
  z.object({ outcome: z.literal("invalid-output") }),
]);
export type HostServiceStatusResponse = z.infer<
  typeof hostServiceStatusResponseSchema
>;

export const hostServiceRegisterRequestSchema = emptyRequestSchema;
export type HostServiceRegisterRequest = z.infer<
  typeof hostServiceRegisterRequestSchema
>;

/**
 * `cli-failed` carries the CLI's own message, which the other maintenance methods throw away.
 * A caller must therefore treat a dropped connection on this method as a probable success - the host restarting - and never as a failed registration.
 */
export const hostServiceRegisterResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("ok") }),
    z.object({ outcome: z.literal("externally-managed") }),
    z.object({ outcome: z.literal("cli-unavailable") }),
    z.object({
      outcome: z.literal("cli-failed"),
      message: z.string().nullable(),
    }),
    z.object({ outcome: z.literal("invalid-output") }),
  ],
);
export type HostServiceRegisterResponse = z.infer<
  typeof hostServiceRegisterResponseSchema
>;

export const hostServiceDeregisterRequestSchema = emptyRequestSchema;
export type HostServiceDeregisterRequest = z.infer<
  typeof hostServiceDeregisterRequestSchema
>;

/**
 * `accepted`, not `ok` - and the difference is the whole contract.
 * A caller must therefore treat a dropped connection after `accepted` as the EXPECTED outcome rather than a failure, and must not promise the user it worked.
 */
export const hostServiceDeregisterResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("accepted") }),
    /** Same host-side refusal as register's: an external supervisor owns it. */
    z.object({ outcome: z.literal("externally-managed") }),
    z.object({ outcome: z.literal("cli-unavailable") }),
    z.object({ outcome: z.literal("cli-failed") }),
  ],
);
export type HostServiceDeregisterResponse = z.infer<
  typeof hostServiceDeregisterResponseSchema
>;
