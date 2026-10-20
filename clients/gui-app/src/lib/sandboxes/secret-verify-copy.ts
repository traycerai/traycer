import type {
  SecretVerifyHop,
  SecretVerifyResult,
} from "@traycer/protocol/host/environment-schemas";
import {
  SANDBOX_ROUTE_PROTOCOLS,
  isSandboxDatabaseEngine,
} from "@traycer/protocol/host/secret-intake-catalogue";
import { secretProtocolLabel } from "@/lib/sandboxes/secret-intake-copy";

/**
 * What Verify reports. One probe answers with the hop that refused it: host,
 * port or protocol, and for a database the login too, never for HTTPS. A
 * refusal names the setting that is the likely cause, so a wrong port reads as
 * the port this secret is set to. An accepted HTTPS probe reached the
 * destination only: the key itself is checked the first time an agent uses it.
 *
 * `where` is where that setting is: "above" in the add dialog, the secret's
 * own settings on a row.
 */

export type SecretVerifyWhere = "dialog" | "row";

export interface SecretVerifyLine {
  readonly tone: "success" | "warning";
  readonly text: string;
}

function isDatabaseProtocol(protocol: string): boolean {
  const known = SANDBOX_ROUTE_PROTOCOLS.find((entry) => entry === protocol);
  return known !== undefined && isSandboxDatabaseEngine(known);
}

function settingPhrase(setting: string, where: SecretVerifyWhere): string {
  return where === "dialog"
    ? `Check the ${setting} above.`
    : `Check the ${setting} this secret is set to.`;
}

function refusedLine(
  hop: SecretVerifyHop,
  protocol: string,
  where: SecretVerifyWhere,
): string {
  switch (hop) {
    case "host":
      return `The host did not answer. ${settingPhrase("host", where)}`;
    case "port":
      return `Nothing answered on that port. ${settingPhrase("port", where)}`;
    case "protocol":
      return `Something answered, but not ${secretProtocolLabel(protocol)}. ${settingPhrase("port and protocol", where)}`;
    case "login":
      return `The server refused the login. ${settingPhrase("login and value", where)}`;
  }
}

export function secretVerifyLine(
  result: SecretVerifyResult,
  protocol: string,
  where: SecretVerifyWhere,
): SecretVerifyLine {
  switch (result.evidence) {
    case "probe_accepted":
      return {
        tone: "success",
        text: isDatabaseProtocol(protocol)
          ? "Reached the database and logged in."
          : "Reached the destination. The key is checked the first time an agent uses it.",
      };
    case "probe_refused":
      return {
        tone: "warning",
        text: refusedLine(result.hop, protocol, where),
      };
    case "unreachable":
      return {
        tone: "warning",
        text: "Couldn't check right now. Try again in a moment.",
      };
  }
}
