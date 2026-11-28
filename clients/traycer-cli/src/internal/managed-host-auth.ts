import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readCliAuthMode,
  type CliAuthMode,
} from "@traycer/protocol/config/managed-cli-auth";
import {
  MANAGED_CLI_AUTH_PATH,
  MANAGED_CLI_HOST_HEADER,
  MANAGED_CLI_WAITING_HEADER,
  MANAGED_CLI_WAITING,
  MANAGED_CLI_REFUSAL,
  MANAGED_CLI_RETRY,
  MANAGED_CLI_UNCONFIRMED,
  managedCliAccountSchema,
  type ManagedCliIdentity,
} from "@traycer/protocol/host/managed-cli-auth";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import { z } from "zod";
import { config } from "../config";
import {
  isValidLocalHostWebsocketUrl,
  publishedHostProcessGone,
  readHostPidMetadata,
} from "../host/pid-metadata";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import type { CommandContext, CommandResult } from "../runner/runner";
import { hostHomeDir } from "../store/paths";

export const MANAGED_SIGN_IN = MANAGED_CLI_REFUSAL;
const STOPPED =
  "Traycer is not running on this machine. Run `traycer host ensure`.";
export const MANAGED_ACCOUNT_UNCONFIRMED = MANAGED_CLI_UNCONFIRMED;

async function currentCliAuthMode(): Promise<CliAuthMode> {
  let hostDataDir: string;
  try {
    hostDataDir = hostHomeDir(config.environment);
  } catch {
    // Keep ordinary commands' existing invalid-slot handling.
    return "interactive";
  }
  return readCliAuthMode(hostDataDir);
}

export async function isManagedCliAuth(): Promise<boolean> {
  return (await currentCliAuthMode()) === "managed";
}

export async function isManagedSignIn(): Promise<boolean> {
  const mode = await currentCliAuthMode();
  if (mode === "unreadable") throw managedUnavailable(false);
  return mode === "managed";
}

export function managedSignInRefusal(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AUTH_REJECTED,
    message: MANAGED_SIGN_IN,
    details: null,
    exitCode: 1,
  });
}

const credentialRecord = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  refreshToken: z.null(),
});

const storedClaims = z.object({
  aud: z.union([z.literal("host"), z.tuple([z.literal("host")])]),
  hostId: z.string().min(1),
  exp: z.number().optional(),
  id: z.string().min(1).optional(),
  principal: z.string().optional(),
  teamId: z.string().min(1).optional(),
  actAs: z.undefined().optional(),
  cls: z.undefined().optional(),
});

interface StoredHostAuth {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly identity: ManagedCliIdentity;
}

async function readStoredHostAuth(
  hostId: string | null,
): Promise<StoredHostAuth | "wrong-host" | null> {
  let wrongHost = false;
  const directory = join(hostHomeDir(config.environment), "identity");
  for (const filename of ["device-credentials.json", "team-credential.json"]) {
    try {
      const { token } = credentialRecord.parse(
        JSON.parse(await readFile(join(directory, filename), "utf8")),
      );
      const claims = storedClaims.parse(
        JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
        ),
      );
      if (hostId !== null && claims.hostId !== hostId) {
        wrongHost = true;
        continue;
      }
      const expiresAtMs = (claims.exp ?? 0) * 1000;
      if (claims.principal === "team" && claims.teamId !== undefined) {
        return {
          token,
          expiresAtMs,
          identity: { kind: "team", id: claims.teamId, label: claims.teamId },
        };
      }
      if (claims.principal === undefined && claims.id !== undefined) {
        return {
          token,
          expiresAtMs,
          identity: { kind: "user", id: claims.id, label: claims.id },
        };
      }
    } catch {
      // An absent or invalid record supplies no authentication.
    }
  }
  return wrongHost ? "wrong-host" : null;
}

function managedAuthUrl(endpoint: HostTransportEndpoint): URL | null {
  const { websocketUrl } = endpoint;
  if (websocketUrl === null || !isValidLocalHostWebsocketUrl(websocketUrl))
    return null;
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = MANAGED_CLI_AUTH_PATH;
  return url;
}

/** Discover the versioned local door without sending a bearer to released peers. */
export async function readManagedHostCredential(
  endpoint: HostTransportEndpoint,
  signal: AbortSignal | null,
): Promise<StoredHostAuth> {
  const url = managedAuthUrl(endpoint);
  if (url === null) throw managedUnavailable(false);
  const stored = await readStoredHostAuth(endpoint.hostId);
  if (stored === "wrong-host") throw managedUnavailable(false);
  if (stored === null || stored.expiresAtMs <= Date.now())
    throw managedWaiting();
  const availability = await managedDoorAvailability(
    url,
    endpoint.hostId,
    signal,
  );
  if (availability !== "available")
    throw managedUnavailable(availability === "unreachable");
  return stored;
}

async function managedDoorAvailability(
  url: URL,
  hostId: string,
  signal: AbortSignal | null,
): Promise<"available" | "unsupported" | "unreachable"> {
  const probe = await fetch(url, {
    method: "HEAD",
    redirect: "error",
    signal: managedDeadline(signal),
  }).catch(() => null);
  if (probe === null || probe.status >= 500) return "unreachable";
  return probe.status === 204 &&
    probe.headers.get(MANAGED_CLI_HOST_HEADER) === hostId
    ? "available"
    : "unsupported";
}

function managedDeadline(signal: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(5_000);
  return signal === null ? deadline : AbortSignal.any([deadline, signal]);
}

export function managedUnavailable(canRetry: boolean): CliError {
  return cliError({
    code: canRetry
      ? CLI_ERROR_CODES.HOST_UNREACHABLE
      : CLI_ERROR_CODES.AUTH_REJECTED,
    message: canRetry ? MANAGED_CLI_RETRY : MANAGED_ACCOUNT_UNCONFIRMED,
    details: null,
    exitCode: 1,
  });
}

export function managedWaiting(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_UNREACHABLE,
    message: MANAGED_CLI_WAITING,
    details: null,
    exitCode: 1,
  });
}

export function managedHostStopped(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_NOT_RUNNING,
    message: STOPPED,
    details: null,
    exitCode: 1,
  });
}

type ManagedAccount =
  | { readonly status: "waiting" | "unconfirmed" | "unreachable" | "stopped" }
  | {
      readonly status: "stored-managed" | "valid-team";
      readonly identity: ManagedCliIdentity;
    }
  | {
      readonly status: "valid";
      readonly identity: ManagedCliIdentity;
      readonly user: {
        readonly id: string;
        readonly email: string;
        readonly name: string;
      };
      readonly authnBaseUrl: string;
    };

async function readManagedAccount(local: boolean): Promise<ManagedAccount> {
  if (local) {
    const stored = await readStoredHostAuth(null);
    if (stored !== null && stored !== "wrong-host")
      return { status: "stored-managed", identity: stored.identity };
  }
  const metadata = await readHostPidMetadata(config.environment);
  if (metadata === null || publishedHostProcessGone(metadata)) {
    return { status: "stopped" };
  }
  const url = managedAuthUrl(metadata);
  if (url === null) return { status: "unconfirmed" };
  const stored = await readStoredHostAuth(metadata.hostId);
  if (stored === "wrong-host") return { status: "unconfirmed" };
  if (stored === null || stored.expiresAtMs <= Date.now() || local)
    return { status: "waiting" };
  const availability = await managedDoorAvailability(
    url,
    metadata.hostId,
    null,
  );
  if (availability !== "available") {
    return {
      status: availability === "unreachable" ? "unreachable" : "unconfirmed",
    };
  }
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${stored.token}` },
      redirect: "error",
      signal: managedDeadline(null),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (
        response.status === 503 &&
        response.headers.get(MANAGED_CLI_WAITING_HEADER) === "1"
      )
        return { status: "waiting" };
      return { status: response.status >= 500 ? "unreachable" : "unconfirmed" };
    }
    const account = managedCliAccountSchema.safeParse(await response.json());
    if (!account.success) return { status: "unconfirmed" };
    const { kind, id, label } = account.data;
    const identity = { kind, id, label };
    return account.data.kind === "team"
      ? { status: "valid-team", identity }
      : {
          status: "valid",
          identity,
          user: account.data.user,
          authnBaseUrl: account.data.authnBaseUrl,
        };
  } catch {
    return { status: "unreachable" };
  }
}

function accountLine(account: ManagedAccount): string {
  if (account.status === "waiting") return MANAGED_CLI_WAITING;
  if (account.status === "stopped") return STOPPED;
  if (account.status === "unreachable") return MANAGED_CLI_RETRY;
  if (!("identity" in account)) return MANAGED_ACCOUNT_UNCONFIRMED;
  const { identity } = account;
  const label = identity.label.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");
  const display = identity.kind === "team" ? `team ${label}` : label;
  return account.status === "stored-managed"
    ? `Stored Traycer account: ${display} (unverified).`
    : `Signed in as ${display}. ${MANAGED_SIGN_IN}`;
}

export async function managedAccountNote(): Promise<string> {
  return accountLine(await readManagedAccount(false));
}

export async function managedAccountResult(
  ctx: CommandContext,
  local: boolean,
): Promise<CommandResult> {
  const account = await readManagedAccount(local);
  if (account.status === "waiting") throw managedWaiting();
  if (account.status === "unreachable") throw managedUnavailable(true);
  return {
    data: {
      ...account,
      validated: account.status === "valid" || account.status === "valid-team",
      credentialUpdate: "none",
    },
    human: ctx.runtime.json ? null : accountLine(account),
    exitCode: "identity" in account ? 0 : 1,
  };
}
