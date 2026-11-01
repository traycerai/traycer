import type {
  EnvironmentSecretsCreateRequest,
  EnvironmentSecretsCreateRequestV11,
  EnvironmentSecretsVerifyRequest,
  EnvironmentSecretsVerifyRequestV11,
} from "@traycer/protocol/host/environment-schemas";
import {
  SANDBOX_DATABASE_DEFAULT_PORT,
  SANDBOX_DATABASE_UPSTREAM_MECHANISMS,
  SANDBOX_PLAINTEXT_DISCLOSURE_VERSION,
  SANDBOX_SECRET_KIND_PROTOCOLS,
  SANDBOX_SECRET_NAME_PATTERN,
  isSandboxDatabaseEngine,
  type SandboxConnectionDialect,
  type SandboxRouteProtocol,
  type SandboxSecretMode,
  type SandboxSecretSwapSite,
} from "@traycer/protocol/host/secret-intake-catalogue";
import {
  secretDefaultVariableName,
  secretKindProtocols,
  secretProtocolUnsupportedReason,
  secretVariableDialects,
  type DesktopSecretKind,
} from "@/lib/sandboxes/secret-intake-copy";

/**
 * The desktop add dialog's state and the requests it becomes: an API key, a
 * model provider key or a database login, with the plain field set authn's
 * create takes. One flat state, so switching protocol keeps what still applies;
 * every field the request lists is sent, null where the kind has none.
 *
 * The typed value lives in this state only: it is sent by a direct request
 * and never handed to a query or mutation cache.
 */

export interface SecretFormVariable {
  /** The row's own key in the form; never sent. */
  readonly id: number;
  readonly name: string;
  readonly dialect: SandboxConnectionDialect;
}

export interface SecretFormState {
  readonly kind: DesktopSecretKind;
  readonly name: string;
  readonly protocol: SandboxRouteProtocol;
  readonly mode: SandboxSecretMode;
  /** "Sandboxes get it": granted to every live and future sandbox. */
  readonly sandboxesByDefault: boolean;
  /** One or more hosts, separated by commas, spaces or new lines. */
  readonly hosts: string;
  /** Empty for the protocol's default port. */
  readonly port: string;
  /** The database login. */
  readonly identity: string;
  /** The database, schema or warehouse. */
  readonly database: string;
  readonly value: string;
  readonly variables: readonly SecretFormVariable[];
  /** Where an API key appears in a request. */
  readonly swapSites: readonly SandboxSecretSwapSite[];
  /** The person confirmed the plaintext lines a brokered database login shows. */
  readonly plaintextConsent: boolean;
}

function defaultVariables(
  protocol: SandboxRouteProtocol,
): readonly SecretFormVariable[] {
  const dialect = secretVariableDialects(protocol).at(0);
  return dialect === undefined
    ? []
    : [{ id: 0, name: secretDefaultVariableName(protocol), dialect }];
}

/** A key for one more variable row, unused by the rows there. */
export function nextVariableId(state: SecretFormState): number {
  return (
    state.variables.reduce((max, entry) => Math.max(max, entry.id), -1) + 1
  );
}

function defaultPort(protocol: SandboxRouteProtocol): string {
  return isSandboxDatabaseEngine(protocol)
    ? String(SANDBOX_DATABASE_DEFAULT_PORT[protocol])
    : "";
}

/** A fresh form for a kind: its first protocol, brokered, granted by default. */
export function initialSecretForm(kind: DesktopSecretKind): SecretFormState {
  const protocol =
    secretKindProtocols(kind)[0] ?? SANDBOX_SECRET_KIND_PROTOCOLS[kind][0];
  return {
    kind,
    name: "",
    protocol,
    mode: "brokered",
    sandboxesByDefault: true,
    hosts: "",
    port: defaultPort(protocol),
    identity: "",
    database: "",
    value: "",
    variables: defaultVariables(protocol),
    swapSites: ["header"],
    plaintextConsent: false,
  };
}

/**
 * Another protocol of the same kind: the port and the variables are that
 * protocol's, and a consent given for the old one is not a consent to the
 * new one's lines.
 */
export function withSecretProtocol(
  state: SecretFormState,
  protocol: SandboxRouteProtocol,
): SecretFormState {
  return {
    ...state,
    protocol,
    port: defaultPort(protocol),
    variables: defaultVariables(protocol),
    plaintextConsent: false,
  };
}

function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function secretFormHosts(state: SecretFormState): readonly string[] {
  return splitList(state.hosts);
}

/** The port to send: null for the protocol's default, NaN when unreadable. */
export function secretFormPort(state: SecretFormState): number | null {
  const text = state.port.trim();
  if (text.length === 0) return null;
  return /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
}

/** Whether saving waits for the plaintext lines to be confirmed. */
export function secretFormNeedsConsent(state: SecretFormState): boolean {
  return state.mode === "brokered" && state.kind === "database";
}

const HOSTNAME = /^[A-Za-z0-9._-]{1,253}$/;

function destinationProblem(state: SecretFormState): string | null {
  const hosts = secretFormHosts(state);
  if (hosts.length === 0) return "Enter the server address.";
  if (hosts.length > 16) return "A secret reaches at most 16 hosts.";
  const bad = hosts.find((host) => !HOSTNAME.test(host));
  if (bad !== undefined) {
    return `${bad} is not a hostname: letters, digits, dots and dashes only.`;
  }
  const port = secretFormPort(state);
  if (port !== null && !(port >= 1 && port <= 65_535)) {
    return "The port is a number from 1 to 65535.";
  }
  return null;
}

function variablesProblem(state: SecretFormState): string | null {
  const allowed = secretVariableDialects(state.protocol);
  const seen = new Set<string>();
  for (const variable of state.variables) {
    if (!SANDBOX_SECRET_NAME_PATTERN.test(variable.name)) {
      return "A variable name is capital letters, digits and underscores, starting with a letter.";
    }
    if (seen.has(variable.name)) {
      return `The variable ${variable.name} is named twice.`;
    }
    if (!allowed.includes(variable.dialect)) {
      return `${variable.name} uses a format this protocol does not have.`;
    }
    seen.add(variable.name);
  }
  return null;
}

/**
 * What stops Verify: the destination and the login, never the name. `null`
 * when the candidate can be checked.
 */
export function secretVerifyProblem(state: SecretFormState): string | null {
  const unsupported = secretProtocolUnsupportedReason(state.protocol);
  if (unsupported !== null) return unsupported;
  const destination = destinationProblem(state);
  if (destination !== null) return destination;
  if (state.kind === "database" && state.identity.trim().length === 0) {
    return "Enter the login.";
  }
  return state.value.length === 0 ? "Enter the value." : null;
}

/**
 * What stops this form from being saved, the first problem first; `null`
 * when it can be sent. The broker checks everything again and is the
 * authority: these are the checks that need no round trip.
 */
export function secretFormProblem(state: SecretFormState): string | null {
  if (!SANDBOX_SECRET_NAME_PATTERN.test(state.name)) {
    return "The name is capital letters, digits and underscores, starting with a letter.";
  }
  const problem = secretVerifyProblem(state) ?? variablesProblem(state);
  if (problem !== null) return problem;
  if (state.kind === "api_key" && state.swapSites.length === 0) {
    return "Choose where the key appears in a request.";
  }
  if (secretFormNeedsConsent(state) && !state.plaintextConsent) {
    return "Confirm the plaintext notice, or choose exposed.";
  }
  return null;
}

function nullIfBlank(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A database login's fence; null for the HTTP kinds, which carry none. */
function requestPolicy(
  state: SecretFormState,
): EnvironmentSecretsCreateRequest["policy"] {
  const engine = state.protocol;
  if (!isSandboxDatabaseEngine(engine)) return null;
  return {
    class: "database",
    engine,
    database: nullIfBlank(state.database),
    upstreamMechanism: SANDBOX_DATABASE_UPSTREAM_MECHANISMS[engine][0],
    authSource: null,
    replicaSet: null,
    tdsVersion: engine === "tds" ? "7.4" : null,
    // The consent time is the broker's record of the request's
    // `plaintextConsent`; a time sent here is never stored.
    plaintextConsentAt: null,
    members: [],
  };
}

/** The binding both Verify's candidate and the create carry. */
type SecretBindingFields = Omit<
  Extract<EnvironmentSecretsVerifyRequest, { target: "candidate" }>,
  "target"
>;

function bindingFields(state: SecretFormState): SecretBindingFields {
  const port = secretFormPort(state);
  return {
    kind: state.kind,
    protocol: state.protocol,
    hosts: [...secretFormHosts(state)],
    port: port !== null && Number.isNaN(port) ? null : port,
    identity: state.kind === "database" ? nullIfBlank(state.identity) : null,
    database: state.kind === "database" ? nullIfBlank(state.database) : null,
    policy: requestPolicy(state),
    tlsPolicy: null,
    pinnedHostKeys: null,
    connectorId: null,
    confirmedAddresses: null,
    value: state.value,
  };
}

/** Verify's candidate: the dialog's binding before the secret exists. */
export function secretVerifyCandidateRequest(
  state: SecretFormState,
): EnvironmentSecretsVerifyRequestV11 {
  return { target: "candidate", ...bindingFields(state), environmentId: null };
}

/** The create request for a form `secretFormProblem` passed. */
export function secretCreateRequest(
  state: SecretFormState,
): EnvironmentSecretsCreateRequestV11 {
  return {
    environmentId: null,
    name: state.name,
    ...bindingFields(state),
    mode: state.mode,
    portOverride: false,
    swapSites: state.kind === "api_key" ? [...state.swapSites] : ["header"],
    variables: state.variables.map((variable) => ({
      name: variable.name,
      dialect: variable.dialect,
    })),
    exportPolicy: null,
    sandboxesByDefault: state.sandboxesByDefault,
    plaintextConsent:
      secretFormNeedsConsent(state) && state.plaintextConsent
        ? { disclosureVersion: SANDBOX_PLAINTEXT_DISCLOSURE_VERSION }
        : null,
  };
}
