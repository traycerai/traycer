import {
  type ValidationEffect,
  validateStoredCredentials,
} from "../auth/validate";
import { config } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { readCredentials, type StoredCredentials } from "../store/credentials";

// Runner-aware `traycer whoami`. JSON mode emits exactly one terminal
// NDJSON `result` event; human mode prints a single line on stdout (or
// stderr for the network-error path) and the runner owns process.exit.
//
// Exit-code contract (matches the runner.ts "exitCode can be non-zero
// on a successful 'we did our job' result" example):
//   - no-credentials → result.ok, data.status="no-credentials", exit=1
//   - rejected       → result.ok, data.status="rejected",       exit=1
//   - valid          → result.ok, data.status="valid", ...,      exit=0
//   - network-error  → throws CliError(AUTH_NETWORK), exit=2 (true failure)
//
// Reason: callers want to discriminate "logged out / token rejected" from
// "could not reach authn" in scripts - the first two are stable states
// the user can act on; the network error is transient and behaves like
// every other transient CLI failure (NDJSON error envelope, non-zero
// exit, machine-readable code).
//
// ## Why the default is not a read (CLI-018)
//
// The name says identity, but the useful question behind it is "will my next
// Traycer call work", and only the server can answer that. So the default is a
// VALIDATE, and validating is a mutation: a drifted profile is written back,
// and a stale access token is replaced by spending the stored refresh token.
//
// That is disclosed rather than removed. Downgrading the default to a local
// read would make `whoami` answer "logged in" for a revoked session - a worse
// contract for the scripts that use it as an auth gate, and a silent behaviour
// change for every existing caller. Instead:
//   - the help says it validates and may refresh (see `index.ts`);
//   - `data.validated` says whether the answer came from the server;
//   - `data.credentialUpdate` names exactly what was written, so an audit of a
//     `whoami` call does not have to infer it;
//   - `--local` is the truly observational read for callers that want one.
export const whoamiCommand: CommandFn = async (ctx): Promise<CommandResult> => {
  const result = await validateStoredCredentials();
  if (result.kind === "network-error") {
    throw cliError({
      code: CLI_ERROR_CODES.AUTH_NETWORK,
      message:
        result.effect === "none"
          ? "Could not reach the authn service; check your network."
          : "Could not reach the authn service while refreshing the stored credentials; the refresh may or may not have gone through, so the stored credentials may now be stale. Check your network, and run `traycer login` if the next command fails to authenticate.",
      // The error path carries the effect too: a network failure can land
      // AFTER a spend, and this envelope is the only thing the caller gets.
      details: { credentialUpdate: result.effect },
      exitCode: 2,
    });
  }
  if (result.kind === "no-credentials") {
    return {
      // Nothing on disk means nothing was sent and nothing was written:
      // `validated` is false here even though this is the validating mode.
      data: {
        status: "no-credentials" as const,
        validated: false,
        credentialUpdate: result.effect,
      },
      human: ctx.runtime.json
        ? null
        : "Not logged in. Run `traycer login` to authenticate.",
      exitCode: 1,
    };
  }
  if (result.kind === "rejected") {
    return {
      // Usually nothing was written - the spend was refused, or the file was
      // deleted/tombstoned/foreign under the lock. But a rejection can also
      // arrive AFTER a spend whose commit was lost, so the effect is reported
      // rather than assumed, and the human line says so when it happened.
      data: {
        status: "rejected" as const,
        validated: true,
        credentialUpdate: result.effect,
      },
      human: ctx.runtime.json
        ? null
        : `Stored credentials were rejected by the authn service. Run \`traycer login\` to re-authenticate.${humanEffectSuffix(result.effect)}`,
      exitCode: 1,
    };
  }
  const creds = result.credentials;
  return {
    data: {
      status: "valid" as const,
      user: creds.user,
      // The authority the token was just validated against - this build's
      // configured authn, not file content (the file carries no URL).
      authnBaseUrl: config.authnBaseUrl,
      // No `savedAt` here, deliberately. This mode reports a SERVER-validated
      // identity, and the credentials it returns are not always the ones on
      // disk: a `superseded` write means a sibling's pair is in the file, and
      // an unconfirmed commit means nobody knows whose is. A save time is only
      // unambiguous when it comes from a file this command actually read, so
      // it is reported by --local, which does exactly that, and by nothing
      // else.
      validated: true,
      credentialUpdate: result.effect,
    },
    human: ctx.runtime.json
      ? null
      : `Logged in as ${identityOf(creds.user)}.${humanEffectSuffix(result.effect)}`,
    exitCode: 0,
  };
};

// `traycer whoami --local`: the observational half of the pair. Reads the
// credentials file and nothing else - no authn round trip, no refresh spend, no
// write - so it is safe to call in a loop, offline, or while auditing what is
// on the machine.
//
// It answers a strictly weaker question than the default, and the contract says
// so rather than dressing it up: `status` is "stored", not "valid", because a
// present credential proves only that someone signed in here once. It cannot
// return "rejected" - detecting a rejection requires the very round trip this
// mode declines - so exit 0 means "a credential is on disk", not "you are
// authenticated".
export const whoamiLocalCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const stored = await readCredentials();
  if (stored === null) {
    return {
      data: {
        status: "no-credentials" as const,
        validated: false,
        credentialUpdate: "none" as const,
      },
      human: ctx.runtime.json
        ? null
        : "Not logged in. Run `traycer login` to authenticate.",
      exitCode: 1,
    };
  }
  return {
    data: {
      status: "stored" as const,
      user: stored.user,
      // Reported for shape stability with the validating mode: the authority
      // these credentials belong to, from this build's config.
      authnBaseUrl: config.authnBaseUrl,
      savedAt: stored.savedAt,
      validated: false,
      credentialUpdate: "none" as const,
    },
    human: ctx.runtime.json
      ? null
      : `Logged in as ${identityOf(stored.user)} (stored credentials; not checked with Traycer).`,
    exitCode: 0,
  };
};

// Resolves the `--local` flag to the mode that implements it. Mirrors
// `buildLoginCommand`: the flag picks the behaviour once, at registration, so
// neither command body carries a mode branch.
export function buildWhoamiCommand(opts: {
  readonly local: boolean;
}): CommandFn {
  return opts.local ? whoamiLocalCommand : whoamiCommand;
}

function identityOf(user: StoredCredentials["user"]): string {
  return user.email || user.name || user.id;
}

// Names a write the user did not ask for, on the line reporting the read they
// did ask for. Silent when nothing changed, which is the overwhelmingly common
// case - a valid access token and an unchanged profile.
//
// `token-rotation-unconfirmed` is the one that matters: the refresh token was
// spent and the save did not confirm, so the pair on disk may be the dead one -
// this command can answer "signed in" from a session the next command cannot
// use. Exit stays 0 - the identity question WAS answered, truthfully, and this
// command persists nothing itself - but the line has to name the state the next
// command may trip over, or exit 0 becomes the lie.
function humanEffectSuffix(effect: ValidationEffect): string {
  switch (effect) {
    case "none":
      return "";
    case "profile-refreshed":
      return " Updated the stored profile from Traycer.";
    case "profile-refresh-unconfirmed":
      return " Tried to update the stored profile from Traycer; the local write did not confirm.";
    case "token-rotated":
      return " Refreshed the stored access token.";
    case "token-rotation-unconfirmed":
      return " WARNING: a token refresh was attempted and could not be confirmed - the stored credentials may be stale. Run `traycer login` if the next command fails to authenticate.";
  }
}
