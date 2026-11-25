import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { vi } from "vitest";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";
import { CLI_ERROR_CODES } from "../../runner/errors";
import {
  STORED_CREDENTIAL_REJECTED_MESSAGE,
  UNWORDED_MINT_REFUSAL_MESSAGE,
} from "../../internal/host-door-words";
import {
  hostEnrollmentRecordPath,
  hostTeamInstallTokenPath,
} from "../../store/paths";

// The test file that uses these redirects HOME first, so these paths are its temp home.

export function signedInAcmeUser() {
  const base = createAuthenticatedUserFixture(undefined);
  return {
    ...base,
    user: { ...base.user, id: "user-1" },
    environments: {
      personal: null,
      teams: [
        {
          teamId: "organization-acme",
          environmentId: "environment-acme",
        },
      ],
    },
    teamSubscriptions: [
      {
        team: { id: "organization-acme", slug: "acme" },
      } as (typeof base.teamSubscriptions)[number],
    ],
  };
}

export function signedInNonMemberUser() {
  return {
    ...signedInAcmeUser(),
    environments: { personal: null, teams: [] },
    teamSubscriptions: [],
  };
}

export const TEAM_SLUG_SENTENCE =
  "Enter the slug of a team you belong to, as shown in its dashboard address.";
export const AUTHN_UNREACHABLE_SENTENCE =
  "Could not reach the authn service; check your network.";
export const RETAINED_SIGN_IN_WARNING =
  "Your sign-in stays on this computer. Run `traycer logout` to remove it.";

export function registerHostOnMachine(): void {
  const path = hostEnrollmentRecordPath("production");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
}

export function stagedTeamTokenFile(): string | null {
  const path = hostTeamInstallTokenPath("production");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export const TEAM_INSTALL_ROADS = [
  { road: "a machine with no host yet", hostRegistered: false },
  { road: "a machine with a registered host", hostRegistered: true },
];

export const MINT_URL = "https://authn.test/api/v3/hosts/team-install-tokens";
export const MINTED_TOKEN = "minted-install-token";
export const MINTED_ENVIRONMENT_ID = "environment-acme";
export const MINTED_TOKEN_FILE = `${JSON.stringify({
  token: MINTED_TOKEN,
  environmentId: MINTED_ENVIRONMENT_ID,
})}\n`;

export function mintedAnswer(): Response {
  return Response.json(
    {
      token: MINTED_TOKEN,
      environmentId: MINTED_ENVIRONMENT_ID,
      expiresAt: 1_800_000_000,
    },
    { status: 201 },
  );
}

export const MINT_FAILURES = [
  {
    label: "authn does not know the team",
    answer: (): Response | null =>
      Response.json({ code: "environment_not_found" }, { status: 404 }),
    error: {
      code: CLI_ERROR_CODES.FORBIDDEN,
      message: UNWORDED_MINT_REFUSAL_MESSAGE,
    },
    mints: 1,
  },
  {
    label: "authn refuses the mint with a server error",
    answer: (): Response | null =>
      Response.json({ code: "broker_unavailable" }, { status: 503 }),
    error: {
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: AUTHN_UNREACHABLE_SENTENCE,
    },
    mints: 1,
  },
  {
    label: "authn rate-limits the mint with an unrecognized body",
    answer: (): Response | null =>
      Response.json({ message: "rate limited" }, { status: 429 }),
    error: {
      code: CLI_ERROR_CODES.FORBIDDEN,
      message: UNWORDED_MINT_REFUSAL_MESSAGE,
    },
    mints: 1,
  },
  {
    // F6: authn refused the sign-in sent and then takes the stored one, which
    // is asked again: a second refusal is not the sign-in's fault, so no
    // sign-in advice (that needs authn refusing the stored sign-in itself).
    label: "authn refuses the sign-in sent but takes the stored one",
    answer: (): Response | null => new Response(null, { status: 401 }),
    error: {
      code: CLI_ERROR_CODES.FORBIDDEN,
      message: UNWORDED_MINT_REFUSAL_MESSAGE,
    },
    mints: 2,
  },
  {
    label: "authn cannot be reached",
    answer: (): Response | null => null,
    error: {
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: AUTHN_UNREACHABLE_SENTENCE,
    },
    mints: 1,
  },
  {
    label: "authn answers for a different environment",
    answer: (): Response | null =>
      Response.json(
        {
          token: MINTED_TOKEN,
          environmentId: "environment-another-team",
          expiresAt: 1_800_000_000,
        },
        { status: 201 },
      ),
    error: {
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      message: AUTHN_UNREACHABLE_SENTENCE,
    },
    mints: 1,
  },
];

export interface MintRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** A response, or null when the request never completes. */
export function stubMintAnswer(answer: () => Response | null): MintRequest[] {
  const requests: MintRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      const response = answer();
      return response === null
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(response);
    }),
  );
  return requests;
}

export interface InlineSignIn {
  readonly token: string;
  readonly user: { id: string; email: string; name: string };
  readonly authnBaseUrl: string;
}

export function inlineSignIn(token: string): InlineSignIn {
  return {
    token,
    user: { id: "test-person", email: "fixture@example.test", name: "Member" },
    authnBaseUrl: "https://authn.test",
  };
}

export function inlineSignInCredentials(token: string) {
  return {
    token,
    refreshToken: "inline-refresh",
    savedAt: "2026-11-10T00:00:00.000Z",
    user: { id: "test-person", email: "fixture@example.test", name: "Member" },
  };
}
