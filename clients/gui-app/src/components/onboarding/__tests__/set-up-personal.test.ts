import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { providerSetUp } from "@/components/onboarding/set-up-personal";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";

function withProfile(
  kind: ProviderProfile["kind"],
  authStatus: ProviderProfile["auth"]["status"],
): ProviderProfile {
  const base = profile(kind === "ambient" ? "ambient" : "work", kind);
  return { ...base, auth: { ...base.auth, status: authStatus } };
}

function providerWith(
  profiles: ProviderProfile[],
  apiKey: ProviderCliState["apiKey"],
): ProviderCliState {
  return { ...provider("claude-code", profiles), apiKey };
}

const NO_KEY: ProviderCliState["apiKey"] = {
  supported: true,
  configured: false,
  source: null,
};

describe("providerSetUp", () => {
  const cases: ReadonlyArray<
    [label: string, providers: ProviderCliState[], done: boolean]
  > = [
    [
      "a stored API key",
      [
        providerWith([], {
          supported: true,
          configured: true,
          source: "stored",
        }),
      ],
      true,
    ],
    [
      "an authenticated managed profile",
      [providerWith([withProfile("managed", "authenticated")], NO_KEY)],
      true,
    ],
    [
      "an authenticated managed profile among others",
      [
        provider("codex", []),
        providerWith(
          [
            withProfile("ambient", "authenticated"),
            withProfile("managed", "authenticated"),
          ],
          NO_KEY,
        ),
      ],
      true,
    ],
    [
      "an ambient profile alone, even signed in",
      [providerWith([withProfile("ambient", "authenticated")], NO_KEY)],
      false,
    ],
    [
      "a key that comes from a shell variable",
      [providerWith([], { supported: true, configured: true, source: "env" })],
      false,
    ],
    [
      "a key that is not configured",
      [providerWith([], { supported: true, configured: false, source: null })],
      false,
    ],
    [
      "an unauthenticated managed profile",
      [providerWith([withProfile("managed", "unauthenticated")], NO_KEY)],
      false,
    ],
    ["no providers", [], false],
  ];
  it.each(cases)("%s", (_label, providers, done) => {
    expect(providerSetUp(providers)).toBe(done);
  });
});
