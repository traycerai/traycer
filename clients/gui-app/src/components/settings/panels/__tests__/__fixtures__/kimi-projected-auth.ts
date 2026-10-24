import {
  providerCliStateSchema,
  providersAwaitLoginResponseSchema,
  type ProviderCliState,
  type ProvidersAwaitLoginResponse,
} from "@traycer/protocol/host/provider-schemas";

// Mirrors the host's projected Kimi completion response (traycer-internal
// #6345), `traycerai/traycer#2363`. Captured from the host's own resolver test
// ("answers the ambient target as authenticated while the catalog keeps
// reading configured"), with the machine-specific binary path made neutral.
//
// Kimi's credential-file probe can only read `configured`. After a successful
// `kimi login` the host lifts it to `authenticated` on the `providers.awaitLogin`
// RESPONSE alone: the projection is `{ ...rawAuth, status: "authenticated" }`,
// so the badge, label and detail stay as the probe read them and no identity is
// invented. Kimi has no managed profiles, so `profiles` is `[]`. `providers.list`
// keeps the raw `configured`. No protocol schema or version changed.
//
// Static on purpose: this is the wire body as a host sends it, so a change to
// either side that drifts from it shows up here.
const KIMI_AUTH_BADGE = "Kimi account";

const KIMI_CANDIDATES = [
  {
    kind: "bundled",
    path: "/usr/local/bin/kimi",
    version: "2.1.1",
    available: true,
    versionPending: false,
  },
];

const KIMI_NATIVE_CAPABILITIES = {
  supportedTabs: ["general", "env"],
  mcp: null,
  plugins: null,
  skills: null,
  modelProviders: null,
};

const KIMI_STATE_BODY = {
  providerId: "kimi",
  enabled: false,
  disabledBy: null,
  selected: { kind: "bundled" },
  candidates: KIMI_CANDIDATES,
  authPending: false,
  checkedAt: 1792175804591,
  apiKey: { supported: false, configured: false, source: null },
  terminalAgentArgs: "",
  autoJudge: "traycer",
  envOverrides: [],
  loginCapability: null,
  availabilityPending: false,
  nativeCapabilities: KIMI_NATIVE_CAPABILITIES,
  cliBinaryResolved: true,
  profiles: [],
  managedInstallState: null,
  packId: null,
  managedVersions: null,
  managedVersionsUnavailable: null,
  nextRunBinary: {
    kind: "bundled",
    path: "/usr/local/bin/kimi",
    version: "2.1.1",
  },
  versionVisibility: null,
  advisory: null,
};

/** The `providers.awaitLogin` body for a successful Kimi sign-in, projected. */
const PROJECTED_AWAIT_LOGIN_BODY = {
  state: {
    ...KIMI_STATE_BODY,
    auth: {
      status: "authenticated",
      badgeText: KIMI_AUTH_BADGE,
      label: null,
      detail: null,
    },
  },
  existingProfileId: null,
  codeRejected: false,
  refusal: null,
};

/** The same completion before the host's projection: top-level `configured`. */
const RAW_AWAIT_LOGIN_BODY = {
  ...PROJECTED_AWAIT_LOGIN_BODY,
  state: {
    ...KIMI_STATE_BODY,
    auth: {
      status: "configured",
      badgeText: KIMI_AUTH_BADGE,
      label: null,
      detail: null,
    },
  },
};

/** The Kimi row `providers.list` keeps serving: raw `configured`. */
const KIMI_LIST_ROW_BODY = {
  ...KIMI_STATE_BODY,
  auth: {
    status: "configured",
    badgeText: KIMI_AUTH_BADGE,
    label: null,
    detail: null,
  },
};

// Parsed the way the client transport parses a response, so the fixtures carry
// exactly the typed shape the flows receive.
export const PROJECTED_KIMI_AWAIT_LOGIN: ProvidersAwaitLoginResponse =
  providersAwaitLoginResponseSchema.parse(PROJECTED_AWAIT_LOGIN_BODY);

export const RAW_KIMI_AWAIT_LOGIN: ProvidersAwaitLoginResponse =
  providersAwaitLoginResponseSchema.parse(RAW_AWAIT_LOGIN_BODY);

export const KIMI_LIST_ROW: ProviderCliState =
  providerCliStateSchema.parse(KIMI_LIST_ROW_BODY);
