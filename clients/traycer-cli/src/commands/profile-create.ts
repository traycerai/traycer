import {
  PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
  providersListRequestSchema,
  providersListResponseSchema,
  providersStartLoginRequestSchemaV13,
  providersStartLoginResponseSchemaV12,
  providersAwaitLoginRequestSchema,
  providersAwaitLoginResponseSchema,
  providersSubmitLoginCodeRequestSchema,
  providersSubmitLoginCodeResponseSchema,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-ids";
import {
  providersCreateApiKeyProfileRequestSchema,
  providersCreateApiKeyProfileResponseSchema,
  profileCredentialKindSchema,
  profileSeedSourceSchema,
  type ProfileEndpointTestVerdict,
  type ProfileSeedSource,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";

/**
 * `traycer profile create` - mints a new provider profile either
 * non-interactively from an API key (`--api-key`) or by driving a sign-in
 * flow (`--sign-in`). Exactly one of the two must be given (D23).
 *
 * The API-key path is a single `providers.createApiKeyProfile` call: D10
 * requires a passing connection test before the host keeps the profile, so a
 * failed test is an ordinary refusal (exit 1, host reason), never a thrown
 * error. The sign-in path drives `providers.startLogin` (D22's
 * client-selected `mode`), then either `providers.submitLoginCode` (for a
 * paste-code provider, signalled by the provider's own
 * `loginCapability.codePaste`) or a direct `providers.awaitLogin` long-poll.
 *
 * Both paths read the provider's row from `providers.list` first, and every
 * per-provider decision below comes off that row rather than a client-side
 * provider table (rule 11): whether `maxContextSize` is required
 * (`endpointCapabilities.extraFields`), whether the login child takes a
 * pasted code (`loginCapability.codePaste`), and whether the provider can be
 * signed in headlessly at all (`loginCapability.terminalLogin`).
 */
export function buildProfileCreateCommand(opts: {
  readonly provider: string;
  readonly label: string;
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly maxContextSize: string | null;
  readonly credentialKind: string | null;
  readonly startFrom: string;
  readonly signIn: boolean;
  readonly mode: string;
}): CommandFn {
  return async (ctx) => {
    const hasApiKey = opts.apiKey !== null;
    if (hasApiKey === opts.signIn) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: profile create requires exactly one of --api-key or --sign-in.",
        details: null,
        exitCode: 1,
      });
    }
    const providerId = parseUserInput(providerIdSchema, opts.provider);
    // Parsed before any RPC so a typo in `--start-from` costs nothing.
    const startFrom = parseStartFrom(opts.startFrom);
    const providerRow = await readProviderRow(providerId);
    if (hasApiKey) {
      return createFromApiKey(providerId, providerRow, startFrom, opts);
    }
    return createFromSignIn(
      ctx,
      providerId,
      providerRow,
      startFrom,
      opts.label,
      opts.mode,
    );
  };
}

/**
 * D32's "Start from", as one CLI value. `default-account` is the default -
 * D25 makes it the Add-profile dialog's default and D32 makes seeding a
 * property of every new profile, so a CLI-minted profile that silently
 * inherited nothing was an invisible divergence from the GUI (wave-5 review
 * O6). The wire's `{kind:"empty"}` default stays right for a RELEASED client
 * that never knew the field; it is not right for this one, which knows and
 * is choosing on the user's behalf.
 *
 * D26: the arms are spelled in user-facing vocabulary (`default-account`,
 * not the wire's `defaultAccount`); `empty` and `profile:<id>` carry no
 * vocabulary of their own.
 */
function parseStartFrom(raw: string): ProfileSeedSource {
  const value = raw.trim();
  if (value === "default-account") return { kind: "defaultAccount" };
  if (value === "empty") return { kind: "empty" };
  if (value.startsWith("profile:")) {
    const profileId = value.slice("profile:".length).trim();
    if (profileId.length > 0) {
      return parseUserInput(profileSeedSourceSchema, {
        kind: "profile",
        profileId,
      });
    }
  }
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message:
      "traycer: profile create --start-from expects 'default-account', 'empty', or 'profile:<id>'.",
    details: null,
    exitCode: 1,
  });
}

/**
 * The provider's own `providers.list` row - the single source for every
 * capability this command branches on. Absent means the host does not know
 * this provider at all, which is a refusal, not a silent fall-through to
 * "assume nothing is required".
 */
async function readProviderRow(
  providerId: ProviderId,
): Promise<ProviderCliState> {
  const listResult = await toAgentCliError(
    callHostRpc(
      "providers.list",
      parseUserInput(providersListRequestSchema, { native: null }),
      null,
    ),
  );
  const listResponse = parseCanonicalHostResponse(
    "providers.list",
    providersListResponseSchema,
    listResult,
  );
  const row = listResponse.providers.find(
    (entry) => entry.providerId === providerId,
  );
  if (row === undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: this host does not know the provider '${providerId}'.`,
      details: null,
      exitCode: 1,
    });
  }
  return row;
}

/**
 * D06's per-provider extra endpoint field, read off the wire rather than a
 * client-side provider table. Kimi's pinned build REQUIRES
 * `max_context_size` in its `[models.<alias>]` table, so a create that omits
 * it fails D10's connection test every time - refusing up front, naming the
 * flag, is the honest version of that (wave-5 review O4).
 */
function maxContextSizeRequired(providerRow: ProviderCliState): boolean {
  return (
    providerRow.endpointCapabilities?.extraFields.includes("maxContextSize") ===
    true
  );
}

function parseMaxContextSize(
  raw: string | null,
  providerRow: ProviderCliState,
  providerId: ProviderId,
): number | null {
  if (raw === null) {
    if (!maxContextSizeRequired(providerRow)) return null;
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: profile create --max-context-size <n> is required for '${providerId}'.`,
      details: null,
      exitCode: 1,
    });
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: profile create --max-context-size expects a positive integer.",
      details: null,
      exitCode: 1,
    });
  }
  return parsed;
}

async function createFromApiKey(
  providerId: ProviderId,
  providerRow: ProviderCliState,
  startFrom: ProfileSeedSource,
  opts: {
    readonly label: string;
    readonly apiKey: string | null;
    readonly baseUrl: string | null;
    readonly model: string | null;
    readonly maxContextSize: string | null;
    readonly credentialKind: string | null;
  },
): Promise<CommandResult> {
  // Before stdin is touched: a missing required flag must not consume the
  // caller's piped key first.
  const maxContextSize = parseMaxContextSize(
    opts.maxContextSize,
    providerRow,
    providerId,
  );
  const rawApiKey = opts.apiKey ?? "";
  const credential = rawApiKey === "-" ? await readAllStdin() : rawApiKey;
  if (credential.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer: profile create --api-key - received no key on stdin.",
      details: null,
      exitCode: 1,
    });
  }
  const credentialKind =
    opts.credentialKind === null
      ? "api_key"
      : parseUserInput(profileCredentialKindSchema, opts.credentialKind);
  const request = parseUserInput(providersCreateApiKeyProfileRequestSchema, {
    providerId,
    label: opts.label,
    accentColor: null,
    // D25/D32: `--start-from`, defaulting to the Default account exactly as
    // the Add-profile dialog does.
    startFrom,
    endpoint: {
      baseUrl: opts.baseUrl,
      credentialKind,
      defaultModel: opts.model,
      maxContextSize,
    },
    credential,
  });
  const result = await toAgentCliError(
    callHostRpc("providers.createApiKeyProfile", request, null),
  );
  const response = parseCanonicalHostResponse(
    "providers.createApiKeyProfile",
    providersCreateApiKeyProfileResponseSchema,
    result,
  );
  if (!response.ok) {
    return {
      data: response,
      human: `traycer: profile create refused - ${response.reason}`,
      exitCode: 1,
    };
  }
  return {
    data: response,
    human: `Created profile ${response.profileId} for ${providerId}: ${formatVerdict(response.verdict)}`,
    exitCode: 0,
  };
}

async function createFromSignIn(
  ctx: CommandContext,
  providerId: ProviderId,
  providerRow: ProviderCliState,
  startFrom: ProfileSeedSource,
  label: string,
  rawMode: string,
): Promise<CommandResult> {
  // D23 (amended 2026-09-08): terminal-login providers are out of scope for
  // `--sign-in`. `providers.startLogin` refuses them host-side, but with
  // GUI-shaped copy ("Update Traycer to sign in from a terminal") that reads
  // as "your CLI is out of date" to someone who is already in a terminal.
  // Refusing here names the two paths that actually work (wave-5 review O7).
  if ((providerRow.loginCapability?.terminalLogin ?? null) !== null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        `traycer: '${providerId}' signs in from a real terminal, which --sign-in cannot drive. ` +
        "Sign in from the Traycer app, or run the vendor CLI's own login under " +
        "`traycer profile launch-env`.",
      details: null,
      exitCode: 1,
    });
  }
  // The wire signal for "this provider's login child accepts a pasted code
  // on stdin" (D22: Claude, in both modes) - never re-derived from the
  // provider id, which would duplicate a fact the host already reports
  // (`loginCapability.codePaste`, `provider-schemas.ts:1024`).
  const codePasteCapable =
    (providerRow.loginCapability?.codePaste ?? null) !== null;

  const startRequest = parseUserInput(providersStartLoginRequestSchemaV13, {
    providerId,
    profileId: null,
    createProfile: { label, shareSkillsAndPlugins: false },
    mode: rawMode,
    // D25/D32 parity with the Add-profile dialog - see `parseStartFrom`.
    startFrom,
  });
  const startResult = await toAgentCliError(
    callHostRpc("providers.startLogin", startRequest, null),
  );
  const startResponse = parseCanonicalHostResponse(
    "providers.startLogin",
    providersStartLoginResponseSchemaV12,
    startResult,
  );
  if (!startResponse.started) {
    return {
      data: startResponse,
      human: `traycer: sign-in failed to start for '${providerId}'.`,
      exitCode: 1,
    };
  }

  if (startRequest.mode === "device") {
    const lines: string[] = [];
    if (startResponse.url !== null)
      lines.push(`Verification URL: ${startResponse.url}`);
    if (startResponse.userCode !== null) {
      lines.push(`Code: ${startResponse.userCode}`);
    } else {
      // D21's documented same-major projection: a host below
      // `providers.startLogin@1.2` re-parses this request through the older
      // minor's non-strict schema and drops `mode` without a word, so the
      // user asked for a device flow and got a browser one. A missing
      // `userCode` on a started device login IS that degradation, and saying
      // so is cheaper - and more accurate - than a second read of the
      // negotiated manifest (wave-5 review O11).
      lines.push(
        "This host returned no device code; it is signing in through the browser instead.",
      );
    }
    if (lines.length > 0) ctx.output.humanRequired(lines.join("\n"));
  } else if (codePasteCapable && startResponse.url !== null) {
    ctx.output.humanRequired(`Sign-in URL: ${startResponse.url}`);
  }

  if (codePasteCapable) {
    ctx.output.humanRequired("Paste the code and press Enter:");
    const code = await readPastedCode();
    if (code.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: profile create --sign-in - no code received on stdin.",
        details: null,
        exitCode: 1,
      });
    }
    const submitRequest = parseUserInput(
      providersSubmitLoginCodeRequestSchema,
      {
        providerId,
        profileId: startResponse.profileId,
        code,
      },
    );
    const submitResult = await toAgentCliError(
      callHostRpc("providers.submitLoginCode", submitRequest, null),
    );
    const submitResponse = parseCanonicalHostResponse(
      "providers.submitLoginCode",
      providersSubmitLoginCodeResponseSchema,
      submitResult,
    );
    if (submitResponse.outcome === "noActiveLogin") {
      return {
        data: submitResponse,
        human:
          "traycer: no active sign-in to submit the code to - run --sign-in again.",
        exitCode: 1,
      };
    }
  }

  const awaitRequest = parseUserInput(providersAwaitLoginRequestSchema, {
    providerId,
    profileId: startResponse.profileId,
  });
  // `providers.awaitLogin` is a LONG POLL: the host holds the response until
  // the login child terminates, and the default 15s frame deadline abandons
  // a healthy in-flight sign-in long before a human finishes one (wave-5
  // review O2). Same budget the GUI uses, read from the same constant so the
  // two cannot drift.
  const awaitResult = await toAgentCliError(
    callHostRpc(
      "providers.awaitLogin",
      awaitRequest,
      PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
    ),
  );
  const awaitResponse = parseCanonicalHostResponse(
    "providers.awaitLogin",
    providersAwaitLoginResponseSchema,
    awaitResult,
  );
  if (awaitResponse.codeRejected) {
    return {
      data: awaitResponse,
      human: "traycer: the pasted code was rejected - run --sign-in again.",
      exitCode: 1,
    };
  }
  if (awaitResponse.existingProfileId !== null) {
    return {
      data: awaitResponse,
      human: `Signed in - this account already has a profile (${awaitResponse.existingProfileId}); no duplicate created.`,
      exitCode: 0,
    };
  }
  return {
    data: awaitResponse,
    human: `Signed in profile ${startResponse.profileId ?? "(unknown)"} for ${providerId}.`,
    exitCode: 0,
  };
}

function formatVerdict(verdict: ProfileEndpointTestVerdict): string {
  const timestamp = new Date(verdict.at).toISOString();
  if (verdict.ok) return `ok@${timestamp}`;
  return verdict.reason === null
    ? `failed@${timestamp}`
    : `failed@${timestamp}: ${verdict.reason}`;
}

// Upper bound on waiting for a piped `--api-key -` value, mirroring
// `login.ts`'s `--token -` guard: a non-TTY pipe that is opened and never
// closed would otherwise block forever on EOF.
const STDIN_READ_TIMEOUT_MS = 10_000;

// Reads the credential for `--api-key -`. Refuses an interactive TTY (D07/D30:
// the credential is never typed into a scrollback-visible prompt) and trims a
// trailing newline from the caller's pipe.
async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: profile create --api-key - requires the key to be piped on stdin.",
      details: null,
      exitCode: 1,
    });
  }
  const read = (async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        cliError({
          code: CLI_ERROR_CODES.INVALID_ARGUMENT,
          message: `traycer: profile create --api-key - timed out after ${STDIN_READ_TIMEOUT_MS}ms waiting for a key on stdin.`,
          details: null,
          exitCode: 1,
        }),
      );
    }, STDIN_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Reads one pasted login code from stdin. Unlike `readAllStdin` this is an
// interactive step of the sign-in wizard (open the URL, copy the code, paste
// it back), so it accepts a TTY: a plain (non-raw) stdin read already gets
// one line per Enter key press from the terminal driver, with no readline UI
// needed. Resolves on the first newline, or on stdin closing with no
// newline (a piped, non-interactive caller).
async function readPastedCode(): Promise<string> {
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const newlineIndex = buffered.indexOf("\n");
    if (newlineIndex !== -1) return buffered.slice(0, newlineIndex).trim();
  }
  return buffered.trim();
}
