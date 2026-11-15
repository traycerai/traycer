import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  HostTransportFailureError,
  mayHaveReachedHost,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { BotSendAccountMovedError } from "@/lib/bots/bot-sent-as";

/**
 * What a failed attempt of a bot send that carries a nonce proves (Tracy Bots
 * T249): `refused` when this attempt wrote nothing, else `uncertain`.
 *
 * Nothing was written when the host said so (`notWritten`, set only before
 * its write), when the connection's handshake was below the floor the send
 * needs, when the client refused it before it left for an account no longer
 * signed in (`BotSendAccountMovedError`), and when the transport attests the
 * request never left. Every other failure, an answered error included, may
 * follow the host's write.
 */
export function botSendAttemptOutcome(error: unknown): "refused" | "uncertain" {
  if (error instanceof BotSendAccountMovedError) return "refused";
  if (error instanceof HostRpcError && error.notWritten) return "refused";
  if (error instanceof HostMethodVersionUnsatisfiedError) return "refused";
  if (
    error instanceof HostTransportFailureError &&
    !mayHaveReachedHost(error)
  ) {
    return "refused";
  }
  return "uncertain";
}

/**
 * Whether a failed attempt was refused because the bot is no longer bound
 * where the send was made for (`authority`): the surface reads the bot again.
 * What it proves of the attempt is `botSendAttemptOutcome`'s to say.
 */
export function botSendAuthorityMoved(error: unknown): boolean {
  return (
    error instanceof HostRpcError && error.code === "E_BOT_AUTHORITY_MOVED"
  );
}
