import type { EnvironmentReviewHeldApplyRequest } from "@traycer/protocol/host/environment-schemas";
import { SANDBOX_PLAINTEXT_DISCLOSURE_VERSION } from "@traycer/protocol/host/secret-intake-catalogue";
import { secretProtocolUnsupportedReason } from "@/lib/sandboxes/secret-intake-copy";
import {
  secretFormHosts,
  secretFormNeedsConsent,
  secretFormPort,
  type SecretFormState,
} from "@/lib/sandboxes/secret-intake-form";

const HOSTNAME = /^[A-Za-z0-9._-]{1,253}$/;

/**
 * What stops Keep as a secret: destination, swap sites and gateway consent.
 * The held ciphertext is already on the broker, so there is no value field.
 */
export function heldSecretBindingProblem(
  state: SecretFormState,
): string | null {
  const unsupported = secretProtocolUnsupportedReason(state.protocol);
  if (unsupported !== null) return unsupported;
  const hosts = secretFormHosts(state);
  if (hosts.length === 0) return "Enter the destination host.";
  if (hosts.length > 16) return "A secret reaches at most 16 hosts.";
  const bad = hosts.find((host) => !HOSTNAME.test(host));
  if (bad !== undefined) {
    return `${bad} is not a hostname: letters, digits, dots and dashes only.`;
  }
  const port = secretFormPort(state);
  if (port !== null && !(port >= 1 && port <= 65_535)) {
    return "The port is a number from 1 to 65535.";
  }
  if (state.kind === "api_key" && state.swapSites.length === 0) {
    return "Choose where the key appears in a request.";
  }
  if (secretFormNeedsConsent(state) && !state.plaintextConsent) {
    return "Confirm the plaintext notice.";
  }
  return null;
}

export function heldSecretApplyRequest(
  heldId: string,
  state: SecretFormState,
): Extract<EnvironmentReviewHeldApplyRequest, { choice: "secret" }> {
  const port = secretFormPort(state);
  return {
    heldId,
    choice: "secret",
    kind: state.kind,
    protocol: state.protocol,
    hosts: [...secretFormHosts(state)],
    port: port !== null && Number.isNaN(port) ? null : port,
    portOverride: state.port.trim().length > 0,
    swapSites: state.kind === "api_key" ? [...state.swapSites] : ["header"],
    plaintextConsent:
      secretFormNeedsConsent(state) && state.plaintextConsent
        ? { disclosureVersion: SANDBOX_PLAINTEXT_DISCLOSURE_VERSION }
        : null,
  };
}
