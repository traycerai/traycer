import { createInterface } from "node:readline/promises";
import { readHostOwnershipViaHttp } from "@traycer-clients/shared/host-client/host-ownership";
import { releaseTeamComputerViaHttp } from "@traycer-clients/shared/host-client/team-computer-release";
import {
  callHostRpcAtResolvedEndpoint,
  PLAIN_DISPATCH,
  resolveEndpoint,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveHostAuth } from "../internal/host-auth";
import {
  formatCredentialProvisionNote,
  provisionRunningHostCredential,
} from "../host/install-auth";
import { CLI_ERROR_CODES, cliError, type CliErrorCode } from "../runner/errors";
import type {
  CommandContext,
  CommandFn,
  CommandResult,
} from "../runner/runner";

// Board C17 (Proposal) gives the confirm line, the question and its answers.
// Refusals reuse the CLI's and the app claim's sentence for the same state;
// `failed`, `notTeamComputer`, `cannotAsk` and the help text are built to the
// Proposal of board C30.
const CLAIM_WORDS = {
  belongsTo: (slug: string) => `This computer belongs to ${slug}.`,
  chatsWillStop: (count: number) =>
    `${String(count)} chats are running and will stop.`,
  // What the confirm says when the running count could not be read is not
  // ruled; the slot stays empty until it is.
  runningChatsUnknown: "",
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
  failed: "Could not claim this computer. Try again.",
} as const;

export interface HostClaimArgs {
  /** Skips the question, for scripts (board C17). */
  readonly yes: boolean;
}

/**
 * `traycer host claim`: makes the team computer this CLI runs on the signed-in
 * member's own. A claim revokes the host's sessions at authn, and on a machine
 * with only the CLI nothing else would give the now-personal host a
 * credential, so the command ends with the provisioning `traycer login` runs.
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
    const ownership = await readHostOwnershipViaHttp(
      auth.authnBaseUrl,
      auth.token,
      endpoint.hostId,
    );
    if (ownership.kind !== "ok") {
      throw claimRefused(
        CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        CLAIM_WORDS.ownershipUnconfirmed,
      );
    }
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
    // The release names the team's environment, which the host's row at
    // authn does not carry; the host reads its own binding.
    const binding = await toAgentCliError(
      callHostRpcAtResolvedEndpoint(
        "environment.host.read",
        {},
        endpoint,
        auth,
        PLAIN_DISPATCH,
      ),
    );
    ctx.output.humanRequired(
      confirmLine(owner.name, await readRunningChats()),
    );
    if (!args.yes && !(await confirmClaim(ctx))) {
      return {
        data: { claimed: false, hostId: endpoint.hostId, team: owner.name },
        human: CLAIM_WORDS.declined,
        exitCode: 0,
      };
    }
    const released = await releaseTeamComputerViaHttp(
      auth.authnBaseUrl,
      auth.token,
      endpoint.hostId,
      binding.environment.environmentId,
    );
    ctx.runtime.logger.info("Host claim release settled", {
      environment: ctx.runtime.environment,
      hostId: endpoint.hostId,
      outcome: released.kind,
    });
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
      case "unauthorized":
        throw claimRefused(
          CLI_ERROR_CODES.AUTH_REJECTED,
          CLAIM_WORDS.notMember,
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

/**
 * The team work the claim stops, as the app's claim confirm shows it (board
 * C13). `unknown` is a failed read, a null answer or a host that does not
 * answer; it is never read as `none`.
 */
type RunningChats =
  | { readonly kind: "none" }
  | { readonly kind: "count"; readonly count: number }
  | { readonly kind: "unknown" };

// No host method in this repository answers the count yet.
function readRunningChats(): Promise<RunningChats> {
  return Promise.resolve({ kind: "unknown" });
}

function confirmLine(slug: string, running: RunningChats): string {
  switch (running.kind) {
    case "none":
      return CLAIM_WORDS.belongsTo(slug);
    case "count":
      return `${CLAIM_WORDS.belongsTo(slug)} ${CLAIM_WORDS.chatsWillStop(running.count)}`;
    case "unknown":
      return [CLAIM_WORDS.belongsTo(slug), CLAIM_WORDS.runningChatsUnknown]
        .filter((part) => part !== "")
        .join(" ");
  }
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
