import { createInterface } from "node:readline/promises";
import { readHostOwnershipViaHttp } from "@traycer-clients/shared/host-client/host-ownership";
import { releaseTeamComputerViaHttp } from "@traycer-clients/shared/host-client/team-computer-release";
import {
  callHostRpcAtResolvedEndpoint,
  PLAIN_DISPATCH,
  resolveEndpoint,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveHostAuth, type HostAuth } from "../internal/host-auth";
import { askWithStoredSignIn, sendAs } from "../internal/sign-in-environments";
import {
  formatCredentialProvisionNote,
  provisionRunningHostCredential,
} from "../host/install-auth";
import {
  readRunningChatCount,
  runningChatsLine,
  type RunningChats,
} from "../host/running-chat-count";
import { CLI_ERROR_CODES, cliError, type CliErrorCode } from "../runner/errors";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";

const CLAIM_WORDS = {
  confirm: "This computer will become yours. The team will lose access to it.",
  question: "Claim it as your own? [y/N] ",
  claimed: "This computer is yours.",
  declined: "Nothing changed.",
  signInFirst: "Sign in with `traycer login`, then run the command again.",
  ownershipUnconfirmed:
    "This computer's ownership could not be confirmed. Try again.",
  notTeamComputer: "This computer does not belong to a team.",
  sandbox: "A sandbox cannot be claimed as a computer.",
  cannotAsk: "Pass --yes to claim this computer without the question.",
  noLongerAvailable: "This computer is no longer available to claim.",
  notMember: "Sign in as a member of this team to claim this computer.",
  readOnlySeat: "Only admins and editors of this team can claim this computer.",
  failed: "Could not claim this computer. Try again.",
} as const;

export interface HostClaimArgs {
  readonly yes: boolean;
}

/**
 * A claim revokes the host's sessions at authn, and with only the CLI nothing else
 * would credential the now-personal host, so this ends with `traycer login`'s provisioning.
 */
export function buildHostClaimCommand(args: HostClaimArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const auth = await resolveHostAuth();
    if (auth === null) {
      throw claimRefused(
        CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
        CLAIM_WORDS.signInFirst,
      );
    }
    const endpoint = await resolveEndpoint();
    const ownership = await askWithStoredSignIn(
      auth.userId,
      auth,
      (token) =>
        readHostOwnershipViaHttp(auth.authnBaseUrl, token, endpoint.hostId),
      {
        refusedAgain: ownershipUnconfirmed,
        notConfirmed: ownershipUnconfirmed,
      },
    );
    if (ownership.kind !== "ok") throw ownershipUnconfirmed();
    if (ownership.host.kind === "sandbox") {
      throw claimRefused(CLI_ERROR_CODES.HOST_IS_SANDBOX, CLAIM_WORDS.sandbox);
    }
    const owner = ownership.host.owner;
    if (owner.kind !== "team") {
      throw claimRefused(
        CLI_ERROR_CODES.INVALID_ARGUMENT,
        CLAIM_WORDS.notTeamComputer,
      );
    }
    const signedIn = await storedSignInOf(auth.userId);
    // The release names the team's environment, which the host's row at
    // authn does not carry; the host reads its own binding.
    const binding = await toAgentCliError(
      callHostRpcAtResolvedEndpoint(
        "environment.host.read",
        {},
        endpoint,
        signedIn,
        PLAIN_DISPATCH,
      ),
    );
    const environmentId = binding.environment.environmentId;
    ctx.output.humanRequired(
      confirmLines(
        await readRunningChatCount(endpoint, signedIn, environmentId),
      ),
    );
    if (!args.yes && !(await confirmClaim(ctx))) {
      return {
        data: { claimed: false, hostId: endpoint.hostId, team: owner.name },
        human: CLAIM_WORDS.declined,
        exitCode: 0,
      };
    }
    // The question can outlast that sign-in, or a sign-out end it.
    const now = await storedSignInOf(auth.userId);
    const released = await askWithStoredSignIn(
      auth.userId,
      now,
      async (token) => {
        const answer = await releaseTeamComputerViaHttp(
          now.authnBaseUrl,
          token,
          endpoint.hostId,
          environmentId,
        );
        ctx.runtime.logger.info("Host claim release settled", {
          environment: ctx.runtime.environment,
          hostId: endpoint.hostId,
          outcome: answer.kind,
        });
        return answer;
      },
      { refusedAgain: notMember, notConfirmed: ownershipUnconfirmed },
    );
    switch (released.kind) {
      case "ok":
        break;
      case "not-computer":
        throw claimRefused(
          CLI_ERROR_CODES.HOST_IS_SANDBOX,
          CLAIM_WORDS.sandbox,
        );
      case "not-found":
        throw claimRefused(
          CLI_ERROR_CODES.INVALID_ARGUMENT,
          CLAIM_WORDS.noLongerAvailable,
        );
      case "read-only-seat":
        throw claimRefused(
          CLI_ERROR_CODES.ENVIRONMENT_SEAT_WITHOUT_WRITE,
          CLAIM_WORDS.readOnlySeat,
        );
      case "network-error":
        throw claimRefused(CLI_ERROR_CODES.AUTH_NETWORK, CLAIM_WORDS.failed);
    }
    const credentialProvision = await provisionRunningHostCredential(ctx);
    const provisionNote = formatCredentialProvisionNote(credentialProvision);
    return {
      data: {
        claimed: true,
        hostId: endpoint.hostId,
        team: owner.name,
        credentialProvision,
      },
      human:
        provisionNote === null
          ? CLAIM_WORDS.claimed
          : `${CLAIM_WORDS.claimed}\n${provisionNote}`,
      exitCode: 0,
    };
  };
}

/** The sign-in stored now, `userId`'s only (`sendAs`); none sends nothing. */
async function storedSignInOf(userId: string): Promise<HostAuth> {
  const now = await resolveHostAuth();
  if (now === null) {
    throw claimRefused(
      CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
      CLAIM_WORDS.signInFirst,
    );
  }
  return sendAs(userId, now, async () => now, ownershipUnconfirmed);
}

function ownershipUnconfirmed() {
  return claimRefused(
    CLI_ERROR_CODES.CLOUD_UNREACHABLE,
    CLAIM_WORDS.ownershipUnconfirmed,
  );
}

function notMember() {
  return claimRefused(CLI_ERROR_CODES.AUTH_REJECTED, CLAIM_WORDS.notMember);
}

function confirmLines(running: RunningChats): string {
  const chats = runningChatsLine(running);
  return chats === null
    ? CLAIM_WORDS.confirm
    : `${CLAIM_WORDS.confirm}\n${chats}`;
}

async function confirmClaim(ctx: CommandContext): Promise<boolean> {
  const canPrompt =
    !ctx.runtime.json &&
    !ctx.runtime.nonInteractive &&
    process.stdin.isTTY === true;
  if (!canPrompt) {
    throw claimRefused(CLI_ERROR_CODES.INVALID_ARGUMENT, CLAIM_WORDS.cannotAsk);
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  // Ctrl+C or a closed stdin at the question is the person declining.
  const answer = await prompt
    .question(CLAIM_WORDS.question)
    .catch(() => "")
    .finally(() => prompt.close());
  return /^y(es)?$/i.test(answer.trim());
}

function claimRefused(code: CliErrorCode, message: string) {
  return cliError({ code, message, details: null, exitCode: 1 });
}
