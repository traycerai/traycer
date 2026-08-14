import {
  hostInstallRecordSchema,
  hostStagedRecordSchema,
  storedCliInstallManifestSchema,
  // The browser-safe half deliberately: this module is on the RPC registry the
  // renderer imports, and `./installation` also carries the Node-only readers.
} from "@traycer/protocol/config/installation-records";
import { z } from "zod";

const emptyRequestSchema = z.object({});

/**
 * The CLI doctor report is intentionally represented structurally here rather
 * than importing CLI-owned issue-code constants into protocol. That keeps the
 * wire contract stable when the CLI adds a new diagnostic code.
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

/**
 * The host can only caption doctor issues as trivially green when this RPC
 * arrived over a direct local WebSocket. A relay session proves the relay
 * connection, not the daemon's loopback listener or its local CLI state.
 *
 * `SERVICE_STOPPED`, `PORT_UNREACHABLE`, and `PORT_CONFLICT` are local-WS
 * facts: the responding process accepted the loopback connection on its
 * configured endpoint. PID sidecar codes remain meaningful (the listener may
 * have been started outside its service metadata), and the three host-RPC
 * credential/protocol codes remain meaningful because the spawned CLI uses a
 * separate stored bearer and performs its own negotiation.
 */
export type DoctorTransportVantage = "local-ws" | "relay";

export const LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES = [
  "SERVICE_STOPPED",
  "PORT_UNREACHABLE",
  "PORT_CONFLICT",
] as const;

/** No code is universally proven: a relay-served RPC gets this empty set. */
export const RPC_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES = [] as const;

export function doctorTriviallyGreenIssueCodesForVantage(
  vantage: DoctorTransportVantage,
): readonly string[] {
  return vantage === "local-ws"
    ? LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES
    : RPC_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES;
}

/**
 * Only `https:` and `http:`. A download URL is fetched, so leaving it a bare
 * string let a manifest name a `file:` or `javascript:` target that no
 * signature check would ever get to weigh in on.
 */
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
 * The two arms are genuinely different records, not one record with optional
 * fields.
 *
 * This mirrors what `parsePlatformAsset` in the CLI's own registry parser
 * already enforces: for `available: true` every artifact field must be
 * present and usable - non-empty http(s) URLs, a positive `sizeBytes`, a
 * lowercase 64-char digest - because a partial entry must be published as
 * unavailable rather than half-filled. As one flat object the wire schema
 * accepted exactly the partial entries that parser refuses.
 *
 * That matters here and not only there: this schema validates what a REMOTE
 * host answered, and a remote host is not necessarily running a CLI whose
 * parser is this strict. Both arms keep `unavailableReason` nullable, since
 * an available asset may still carry a note.
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
    // Left wide on purpose: an unavailable platform is published with empty
    // strings and `sizeBytes: 0`, and tightening these would reject the very
    // shape that says "there is no artifact here".
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

/**
 * Whether the answer should include release candidates.
 *
 * `.default(false)` rather than a bare required boolean, and that is the whole
 * compatibility story for this field: a released client that predates it sends
 * `{}`, which a host built from this tree still parses — the default supplies
 * the stable-only behaviour those clients have always got. Making it required
 * would be a required-set change on a client→host slot, which the surface-compat
 * oracle classifies as breaking for exactly that reason.
 *
 * The reverse direction degrades quietly on its own: a host that predates the
 * field parses the request with `z.object({})`, which strips the unknown key and
 * runs `host available --json` without `--include-pre-releases`. So a new client
 * asking an old host for RCs gets the stable list rather than an error — the
 * checkbox appears to do nothing rather than breaking the page, which is the
 * right failure for a filter.
 */
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

export const hostUpdateInstallRequestSchema = z.object({
  version: z.string().min(1),
  force: z.boolean(),
});
export type HostUpdateInstallRequest = z.infer<
  typeof hostUpdateInstallRequestSchema
>;

export const hostUpdateInstallResponseV10Schema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("accepted") }),
    z.object({ outcome: z.literal("externally-managed") }),
    z.object({ outcome: z.literal("cli-unavailable") }),
    z.object({ outcome: z.literal("cli-failed") }),
  ],
);
export type HostUpdateInstallResponseV10 = z.infer<
  typeof hostUpdateInstallResponseV10Schema
>;

/**
 * Minor 1 adds `already-updating`: an update this host started is still
 * running, so this one was not.
 *
 * `accepted` means the detached CLI was SPAWNED, not that it finished — the
 * download, stage, drain and swap all happen after this method has already
 * answered. Without this arm a caller cannot tell "your update is under way"
 * from "nothing is happening", and a second request during that window
 * launches a competing updater: the CLI's lock covers only its brief precheck
 * and promote phases, so two runs download in parallel and can swap twice in a
 * row. A host at 1.0 never returns it, which is why the upgrade path is the
 * identity — every v1.0 response is already a valid v1.1 response.
 */
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

export const hostGetInstallationInfoRequestSchema = emptyRequestSchema;
export type HostGetInstallationInfoRequest = z.infer<
  typeof hostGetInstallationInfoRequestSchema
>;

export const hostGetInstallationInfoResponseSchema = z.discriminatedUnion(
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
export type HostGetInstallationInfoResponse = z.infer<
  typeof hostGetInstallationInfoResponseSchema
>;

/**
 * The OS service registration, over RPC rather than only the local CLI bridge.
 *
 * These three exist because the Overview replaced the bridge-backed host page
 * for EVERY host, and the OS service controls did not come with it — they were
 * recorded as a scope drop, which in practice meant a registration a person
 * could see on the machine in front of them and not on any other. Restoring them
 * as bridge-only would have put the one genuinely per-kind fork back on a page
 * whose premise is that local and remote render the same components.
 *
 * Read and write are separate methods on purpose: the status read is cheap and
 * safe to run whenever the section is open, and the two writes are neither.
 */
/**
 * `externally-managed` is the CLI's word for a registration that EXISTS but is
 * not the CLI's to touch — on macOS, the label loaded from Traycer Desktop's
 * SMAppService in-bundle plist. That is the NORMAL state of a Desktop-managed
 * machine, so a wire enum without it would make `host.service.status` fail on
 * exactly the fleet's most common configuration. A caller must render it as
 * "registered, owned elsewhere" and withhold the CLI-backed mutations.
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
    /** The service label (`ai.traycer.host`, …) — identity, not decoration. */
    label: z.string().min(1),
    /** The plist / unit / scheduled-task path the registration lives at. */
    manifestPath: z.string().min(1),
  }),
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
 * `cli-failed` carries the CLI's own message, which the other maintenance
 * methods throw away.
 *
 * That is not symmetry for its own sake: the most important refusal this
 * command has is `service install` declining to touch a label owned by Desktop's
 * SMAppService ("Traycer Desktop owns host registration on this machine …
 * re-run with --takeover"). Reduced to a bare `cli-failed` the button would say
 * "couldn't register" for a state that is not a fault at all and has a specific
 * remedy, so the string is the payload.
 *
 * Unlike its sibling below this one CAN answer, and the asymmetry is not an
 * oversight. Every refusal is a precondition the CLI checks BEFORE it touches
 * launchd, so those come back over a live connection. What may not come back is
 * SUCCESS: on macOS registering is a bootout/bootstrap/kickstart cycle, which
 * kills this host and starts a new one, while on Linux the same command is an
 * idempotent `systemctl enable --now` that commonly leaves the process in place.
 * A caller must therefore treat a dropped connection on this method as a
 * probable success — the host restarting — and never as a failed registration.
 */
export const hostServiceRegisterResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("ok") }),
    /**
     * The HOST refused before the CLI ran: its updates — and with them its
     * service lifecycle — are owned by an external supervisor
     * (`TRAYCER_HOST_UPDATES=external`, the remote-staging unit being the
     * canonical case). Distinct from a `cli-failed` refusal because the CLI
     * would not refuse: it would install its OWN canonical unit beside the
     * external one, two supervisors over one host home. Mirrors
     * `host.update.install`'s outcome of the same name.
     */
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
 * `accepted`, not `ok` — and the difference is the whole contract.
 *
 * Deregistering boots out the very job that supervises this host, so the host
 * process dies partway through the command that deregisters it. There is no
 * moment at which a synchronous handler could return a result: the connection
 * carrying the response goes away with the process. So the resolver spawns the
 * CLI detached and answers `accepted` — the request was dispatched — exactly as
 * `host.update.install` does for the same structural reason.
 *
 * A caller must therefore treat a dropped connection after `accepted` as the
 * EXPECTED outcome rather than a failure, and must not promise the user it
 * worked. What it can promise is that the host is going away.
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
