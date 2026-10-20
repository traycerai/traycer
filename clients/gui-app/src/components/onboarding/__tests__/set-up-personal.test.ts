import { describe, expect, it } from "vitest";
import type {
  EnvironmentSecret,
  EnvironmentStatusResponse,
} from "@traycer/protocol/host/environment-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  SET_UP_PERSONAL_LEAD,
  SET_UP_PERSONAL_STEPS,
  SET_UP_PERSONAL_TITLE,
  setUpPersonalDone,
  setUpPersonalProgress,
  type SetUpPersonalFacts,
  type SetUpPersonalStepId,
} from "@/components/onboarding/set-up-personal";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import {
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

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

function secret(overrides: Partial<EnvironmentSecret>): EnvironmentSecret {
  return {
    secretId: "secret-1",
    name: "DEPLOY_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    mode: "brokered",
    state: "live",
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
    ...overrides,
  };
}

function facts(overrides: Partial<SetUpPersonalFacts>): SetUpPersonalFacts {
  return { providers: null, secrets: null, status: null, ...overrides };
}

function ids(done: ReadonlySet<SetUpPersonalStepId>): string[] {
  return [...done].sort();
}

describe("the steps", () => {
  it("name three optional steps, each opening the page it names", () => {
    expect(SET_UP_PERSONAL_TITLE).toBe("Set up Personal");
    expect(SET_UP_PERSONAL_LEAD).toBe(
      "Optional. An agent can run as soon as one provider is set up.",
    );
    expect(
      SET_UP_PERSONAL_STEPS.map((step) => [
        step.id,
        step.section,
        step.text,
        step.action,
      ]),
    ).toEqual([
      [
        "provider",
        "providers",
        "Link a plan or add an API key, so your agents can run on every host.",
        "Open Providers",
      ],
      [
        "secret",
        "secrets",
        "Add a secret your agents will need, like a deploy key or a login.",
        "Open Secrets",
      ],
      [
        "agents",
        "agents",
        "Choose how agents are picked for each task.",
        "Open Agent selection",
      ],
    ]);
  });
});

describe("the provider step", () => {
  const cases: ReadonlyArray<
    [label: string, providers: ProviderCliState[] | null, done: boolean]
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
    ["providers not read yet", null, false],
  ];
  it.each(cases)("%s", (_label, providers, done) => {
    expect(setUpPersonalDone(facts({ providers })).has("provider")).toBe(done);
  });
});

describe("the secret step", () => {
  const cases: ReadonlyArray<
    [label: string, secrets: EnvironmentSecret[] | null, done: boolean]
  > = [
    ["a secret that is not revoked", [secret({})], true],
    [
      "one live secret among revoked ones",
      [
        secret({ secretId: "s1", revoked: true }),
        secret({ secretId: "s2", revoked: false }),
      ],
      true,
    ],
    [
      "a secret still waiting for review",
      [secret({ state: "pending_review" })],
      true,
    ],
    ["only revoked secrets", [secret({ revoked: true })], false],
    ["no secrets", [], false],
    ["secrets not read", null, false],
  ];
  it.each(cases)("%s", (_label, secrets, done) => {
    expect(setUpPersonalDone(facts({ secrets })).has("secret")).toBe(done);
  });
});

describe("the agents step", () => {
  const cases: ReadonlyArray<
    [label: string, status: EnvironmentStatusResponse | null, done: boolean]
  > = [
    [
      "an agent selection guide item",
      environmentStatusFixture({
        items: [
          itemStatusFixture({ kind: "agent_selection_guide", key: "guide" }),
        ],
      }),
      true,
    ],
    [
      "a guide item among others",
      environmentStatusFixture({
        items: [
          itemStatusFixture({ kind: "variable", key: "A" }),
          itemStatusFixture({ kind: "agent_selection_guide", key: "guide" }),
        ],
      }),
      true,
    ],
    [
      "other items only",
      environmentStatusFixture({
        items: [itemStatusFixture({ kind: "variable", key: "A" })],
      }),
      false,
    ],
    ["no items", environmentStatusFixture({ items: [] }), false],
    ["status not read", null, false],
  ];
  it.each(cases)("%s", (_label, status, done) => {
    expect(setUpPersonalDone(facts({ status })).has("agents")).toBe(done);
  });
});

describe("setUpPersonalDone", () => {
  it("is empty when nothing has been read", () => {
    expect(ids(setUpPersonalDone(facts({})))).toEqual([]);
  });

  it("marks every step a host's reads settle, in any combination", () => {
    const all = setUpPersonalDone(
      facts({
        providers: [
          providerWith([], {
            supported: true,
            configured: true,
            source: "stored",
          }),
        ],
        secrets: [secret({})],
        status: environmentStatusFixture({
          items: [
            itemStatusFixture({ kind: "agent_selection_guide", key: "guide" }),
          ],
        }),
      }),
    );
    expect(ids(all)).toEqual(["agents", "provider", "secret"]);

    const some = setUpPersonalDone(
      facts({
        providers: [provider("codex", [])],
        secrets: [secret({})],
        status: environmentStatusFixture({}),
      }),
    );
    expect(ids(some)).toEqual(["secret"]);
  });
});

describe("setUpPersonalProgress", () => {
  const cases: ReadonlyArray<
    [done: readonly SetUpPersonalStepId[], text: string]
  > = [
    [[], "0 of 3 done"],
    [["provider"], "1 of 3 done"],
    [["secret", "agents"], "2 of 3 done"],
    [["provider", "secret", "agents"], "Done"],
  ];
  it.each(cases)("%j reads %s", (done, text) => {
    expect(setUpPersonalProgress(new Set(done))).toBe(text);
  });
});
