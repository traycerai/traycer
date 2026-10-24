import type {
  EnvironmentSecret,
  EnvironmentStatusResponse,
} from "@traycer/protocol/host/environment-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { SettingsSectionId } from "@/lib/settings-sections";

/*
 * The checklist's "Set up Personal" group: three optional steps, each opening
 * the page it names, each checked off by what the person's settings already
 * hold, wherever it was done (here or in the dashboard). Pure, so the rules
 * are tested without a host.
 *
 * Copy rule: each step says what it does for the person, in the four words
 * Personal, secret, variable and host.
 */

export const SET_UP_PERSONAL_TITLE = "Set up Personal";

export const SET_UP_PERSONAL_LEAD =
  "Optional. An agent can run as soon as one provider is set up.";

export type SetUpPersonalStepId = "provider" | "secret" | "agents";

export interface SetUpPersonalStep {
  readonly id: SetUpPersonalStepId;
  readonly section: SettingsSectionId;
  readonly text: string;
  readonly action: string;
}

export const SET_UP_PERSONAL_STEPS: ReadonlyArray<SetUpPersonalStep> = [
  {
    id: "provider",
    section: "providers",
    text: "Link a plan or add an API key, so your agents can run on every host.",
    action: "Open Providers",
  },
  {
    id: "secret",
    section: "secrets",
    text: "Add a secret your agents will need, like a deploy key or a login.",
    action: "Open Secrets",
  },
  {
    id: "agents",
    section: "agents",
    text: "Choose how agents are picked for each task.",
    action: "Open Agent selection",
  },
];

/** What the window's host reports, each `null` until read or where unread. */
export interface SetUpPersonalFacts {
  readonly providers: readonly ProviderCliState[] | null;
  readonly secrets: readonly EnvironmentSecret[] | null;
  readonly status: EnvironmentStatusResponse | null;
}

/**
 * A provider this person set up: a linked plan (a signed-in account that is
 * not this computer's own sign-in) or an API key stored for it. This
 * computer's own sign-in does not count, since it is not one of the person's
 * settings.
 */
export function providerSetUp(providers: readonly ProviderCliState[]): boolean {
  return providers.some(
    (provider) =>
      (provider.apiKey.configured && provider.apiKey.source === "stored") ||
      provider.profiles.some(
        (profile) =>
          profile.kind === "managed" && profile.auth.status === "authenticated",
      ),
  );
}

/** Which steps are done, from the facts read so far. */
export function setUpPersonalDone(
  facts: SetUpPersonalFacts,
): ReadonlySet<SetUpPersonalStepId> {
  const done = new Set<SetUpPersonalStepId>();
  if (facts.providers !== null && providerSetUp(facts.providers)) {
    done.add("provider");
  }
  if (facts.secrets?.some((secret) => !secret.revoked) === true) {
    done.add("secret");
  }
  if (
    facts.status?.items.some(
      (item) => item.kind === "agent_selection_guide",
    ) === true
  ) {
    done.add("agents");
  }
  return done;
}

/** "2 of 3 done", or "Done" once every step is. */
export function setUpPersonalProgress(
  done: ReadonlySet<SetUpPersonalStepId>,
): string {
  if (done.size === SET_UP_PERSONAL_STEPS.length) return "Done";
  return `${done.size} of ${SET_UP_PERSONAL_STEPS.length} done`;
}
