import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderAuth } from "@traycer/protocol/host/provider-schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  pinProfile,
  providerState,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { useProfileEligibilityGate } from "@/components/chat/composer/use-profile-eligibility-gate";
import {
  useLandingProviderReauthGate,
  useProviderReauthGate,
} from "@/components/chat/composer/use-provider-reauth-gate";
import type { HostRpcRegistry } from "@/lib/host";

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => holder.client,
}));

vi.mock("sonner", () => ({
  toast: {
    error: () => "toast-1",
    success: () => "toast-1",
    dismiss: () => undefined,
  },
}));

function row(input: {
  readonly profileId: string;
  readonly label: string;
  readonly kind: "ambient" | "managed";
  readonly authStatus: ProviderAuth["status"];
  readonly aliases: readonly string[];
  readonly personNotice: "needs-sign-in" | "waiting" | null;
  readonly terminalOnThisComputer: boolean;
  readonly enabled: boolean;
}): ProviderProfile {
  return pinProfile({ ...input, otherNames: [] });
}

function answerOf(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly removed: ProfileListAnswer["removedProfiles"];
  readonly authStatus: ProviderAuth["status"];
}): ProfileListAnswer {
  return {
    providers: [
      providerState({
        providerId: "codex",
        authStatus: input.authStatus,
        profiles: input.profiles,
      }),
    ],
    native: null,
    removedProfiles: [...input.removed],
  };
}

function hostFor(answer: ProfileListAnswer): ProfileListHost {
  const host = createProfileListHost({
    answer,
    answerProfileName: (request) => ({ label: request.label }),
    failSetEnabled: false,
  });
  holder.client = host.client;
  return host;
}

function LandingProbe(props: { readonly profileId: string | null }) {
  const gate = useLandingProviderReauthGate(
    holder.client,
    "codex",
    props.profileId,
    true,
  );
  return (
    <>
      <p>{gate.reason ?? "clear"}</p>
      <p>{gate.profileLabel ?? "no-label"}</p>
    </>
  );
}

function AuthoritativeProbe(props: { readonly profileId: string | null }) {
  const gate = useProviderReauthGate(
    "codex",
    props.profileId,
    true,
    "authoritative",
  );
  return (
    <>
      <p>{gate.reason ?? "clear"}</p>
      <p>{gate.profileLabel ?? "no-label"}</p>
    </>
  );
}

function EligibilityProbe(props: { readonly profileId: string | null }) {
  const gate = useProfileEligibilityGate(
    holder.client,
    "codex",
    props.profileId,
    true,
  );
  return (
    <>
      <p>{gate.disabled ? "disabled" : "enabled"}</p>
      <p>{gate.profileLabel ?? "no-label"}</p>
    </>
  );
}

function renderLanding(
  answer: ProfileListAnswer,
  profileId: string | null,
): ProfileListHost {
  const host = hostFor(answer);
  render(
    <host.Wrapper>
      <LandingProbe profileId={profileId} />
    </host.Wrapper>,
  );
  return host;
}

const side = row({
  profileId: "side-row",
  label: "Side",
  kind: "managed",
  authStatus: "authenticated",
  aliases: [],
  personNotice: null,
  terminalOnThisComputer: false,
  enabled: true,
});

const work = row({
  profileId: "work-row",
  label: "Work",
  kind: "managed",
  authStatus: "authenticated",
  aliases: ["alias-work"],
  personNotice: null,
  terminalOnThisComputer: false,
  enabled: true,
});

describe("reauth and eligibility pins", () => {
  afterEach(() => {
    holder.client = null;
    cleanup();
  });

  it("an alias pin follows the canonical row's own auth", async () => {
    const signedOut = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "unauthenticated",
      aliases: ["alias-work"],
      personNotice: null,
      terminalOnThisComputer: false,
      enabled: true,
    });
    const host = renderLanding(
      answerOf({
        profiles: [side, signedOut],
        removed: [],
        authStatus: "authenticated",
      }),
      "alias-work",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("profile_unauthenticated")).toBeDefined();
    });
    expect(screen.getByText("Work")).toBeDefined();
    expect(screen.queryByText("profile_missing")).toBeNull();
  });

  it("a signed-in alias pin is not blocked", async () => {
    const host = renderLanding(
      answerOf({
        profiles: [side, work],
        removed: [],
        authStatus: "unauthenticated",
      }),
      "alias-work",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("Work")).toBeDefined();
    });
    expect(screen.getByText("clear")).toBeDefined();
  });

  it("a removed profile id is profile_missing on a non-authoritative seed", async () => {
    const host = renderLanding(
      answerOf({
        profiles: [side, work],
        removed: [
          removedEntry({
            providerId: "codex",
            profileId: "gone-row",
            aliases: [],
          }),
        ],
        authStatus: "authenticated",
      }),
      "gone-row",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("profile_missing")).toBeDefined();
    });
  });

  it("a removed entry alias is profile_missing on a non-authoritative seed", async () => {
    const host = renderLanding(
      answerOf({
        profiles: [side, work],
        removed: [
          removedEntry({
            providerId: "codex",
            profileId: "gone-row",
            aliases: ["gone-alias"],
          }),
        ],
        authStatus: "authenticated",
      }),
      "gone-alias",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("profile_missing")).toBeDefined();
    });
  });

  it("an unknown id stays clear on a non-authoritative seed and is profile_missing when authoritative", async () => {
    const host = renderLanding(
      answerOf({
        profiles: [side, work],
        removed: [],
        authStatus: "authenticated",
      }),
      "missing-id",
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
    });
    expect(screen.getByText("clear")).toBeDefined();
    expect(screen.getByText("no-label")).toBeDefined();
    cleanup();
    const authoritative = hostFor(
      answerOf({
        profiles: [side, work],
        removed: [],
        authStatus: "authenticated",
      }),
    );
    render(
      <authoritative.Wrapper>
        <AuthoritativeProbe profileId="missing-id" />
      </authoritative.Wrapper>,
    );
    await waitFor(() => {
      expect(authoritative.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("profile_missing")).toBeDefined();
    });
  });

  it("needs a sign-in blocks a managed pin and waiting does not", async () => {
    const needsSignIn = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: "needs-sign-in",
      terminalOnThisComputer: false,
      enabled: true,
    });
    const host = renderLanding(
      answerOf({
        profiles: [side, needsSignIn],
        removed: [],
        authStatus: "authenticated",
      }),
      "work-row",
    );
    await waitFor(() => {
      expect(screen.getByText("profile_unauthenticated")).toBeDefined();
    });
    expect(host.listCalls.length).toBeGreaterThan(0);
    cleanup();
    const waiting = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: "waiting",
      terminalOnThisComputer: false,
      enabled: true,
    });
    const waitingHost = renderLanding(
      answerOf({
        profiles: [side, waiting],
        removed: [],
        authStatus: "unauthenticated",
      }),
      "work-row",
    );
    await waitFor(() => {
      expect(waitingHost.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("Work")).toBeDefined();
    });
    expect(screen.getByText("clear")).toBeDefined();
  });

  it("a null pin on a signed-out terminal record blocks even when the provider probe is signed in", async () => {
    const terminal = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "unauthenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      enabled: true,
    });
    const host = renderLanding(
      answerOf({
        profiles: [side, terminal],
        removed: [],
        authStatus: "authenticated",
      }),
      null,
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("profile_unauthenticated")).toBeDefined();
    });
    expect(screen.getByText("Work")).toBeDefined();
  });

  it("a null pin on a terminal record that needs a sign-in blocks even when the provider probe is signed in", async () => {
    const terminal = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: "needs-sign-in",
      terminalOnThisComputer: true,
      enabled: true,
    });
    renderLanding(
      answerOf({
        profiles: [side, terminal],
        removed: [],
        authStatus: "authenticated",
      }),
      null,
    );
    await waitFor(() => {
      expect(screen.getByText("profile_unauthenticated")).toBeDefined();
    });
  });

  it("a usable terminal record is not blocked when the provider probe is signed out", async () => {
    const terminal = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      enabled: true,
    });
    const host = renderLanding(
      answerOf({
        profiles: [side, terminal],
        removed: [],
        authStatus: "unauthenticated",
      }),
      null,
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("Work")).toBeDefined();
    });
    expect(screen.getByText("clear")).toBeDefined();
  });

  it("an ambient terminal row with a null pin reads the provider probe", async () => {
    const ambient = row({
      profileId: "ambient-row",
      label: "Desk login",
      kind: "ambient",
      authStatus: "authenticated",
      aliases: [],
      personNotice: null,
      terminalOnThisComputer: true,
      enabled: true,
    });
    const host = renderLanding(
      answerOf({
        profiles: [ambient, side],
        removed: [],
        authStatus: "unauthenticated",
      }),
      null,
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("provider_unauthenticated")).toBeDefined();
    });
  });

  it("an alias pin takes the canonical row's enabled flag and label", async () => {
    const disabledWork = row({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      authStatus: "authenticated",
      aliases: ["alias-work"],
      personNotice: null,
      terminalOnThisComputer: false,
      enabled: false,
    });
    const host = hostFor(
      answerOf({
        profiles: [side, disabledWork],
        removed: [],
        authStatus: "authenticated",
      }),
    );
    render(
      <host.Wrapper>
        <EligibilityProbe profileId="alias-work" />
      </host.Wrapper>,
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("disabled")).toBeDefined();
    });
    expect(screen.getByText("Work")).toBeDefined();
  });

  it("a removed pin and an unknown id have no eligibility label", async () => {
    const host = hostFor(
      answerOf({
        profiles: [side, work],
        removed: [
          removedEntry({
            providerId: "codex",
            profileId: "gone-row",
            aliases: [],
          }),
        ],
        authStatus: "authenticated",
      }),
    );
    render(
      <host.Wrapper>
        <EligibilityProbe profileId="gone-row" />
      </host.Wrapper>,
    );
    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("no-label")).toBeDefined();
    });
    expect(screen.getByText("enabled")).toBeDefined();
    cleanup();
    const unknown = hostFor(
      answerOf({
        profiles: [side, work],
        removed: [],
        authStatus: "authenticated",
      }),
    );
    render(
      <unknown.Wrapper>
        <EligibilityProbe profileId="missing-id" />
      </unknown.Wrapper>,
    );
    await waitFor(() => {
      expect(unknown.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByText("no-label")).toBeDefined();
    });
  });
});
