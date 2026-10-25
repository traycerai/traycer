import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";
import type { PersonalHostState } from "@/components/settings/personal/personal-page-status";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { SECRET_CUSTODY_SENTENCE } from "@/lib/sandboxes/secrets-page-copy";

const mocks = vi.hoisted(() => ({
  openLink: vi.fn(),
  setApiKeyMutate: vi.fn(),
  clearApiKeyMutate: vi.fn(),
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes keys. */
  credentialRefusal: null as string | null,
}));
const openLink = mocks.openLink;

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({
    mutate: mocks.setApiKeyMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({
    mutate: mocks.clearApiKeyMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => mocks.credentialRefusal,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLink,
}));

function apiKeyState(
  providerId: ProviderCliState["providerId"],
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "path" },
    candidates: [],
    auth: {
      status: "unknown",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    profiles: [],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
});

describe("ProviderApiKeySection dashboard link", () => {
  it("renders the key field without a 'get a key' button when the dashboard URL is null (kiro)", () => {
    // Kiro takes a KIRO_API_KEY but has no stable public key page. The total
    // Record marks that omission with null rather than silently dropping the
    // button the way a Partial record did for any missing entry.
    render(
      <ProviderApiKeySection
        state={apiKeyState("kiro")}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.getByLabelText("API key")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Create an API key/i }),
    ).toBeNull();
  });

  it("renders a 'get a key' button when the dashboard URL is non-null (cursor)", () => {
    render(
      <ProviderApiKeySection
        state={apiKeyState("cursor")}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.getByLabelText("API key")).toBeDefined();
    const button = screen.getByRole("button", {
      name: /Create an API key/i,
    });
    expect(button).toBeDefined();

    fireEvent.click(button);
    expect(openLink).toHaveBeenCalledWith(
      "https://cursor.com/dashboard/api?section=user-keys#user-api-keys",
      "docs",
      null,
    );
  });
});

describe("ProviderApiKeySection on a host that takes no credentials", () => {
  const REFUSAL = "Sandboxes don't take sign-ins";

  function storedKeyState(): ProviderCliState {
    const state = apiKeyState("cursor");
    return {
      ...state,
      apiKey: { supported: true, configured: true, source: "stored" },
    };
  }

  it("disables the field and Save, shows the refusal, and never sends a typed key, by click or by Enter", () => {
    mocks.credentialRefusal = REFUSAL;
    render(
      <ProviderApiKeySection
        state={apiKeyState("cursor")}
        draft="sk-secret"
        onDraftChange={() => undefined}
      />,
    );

    const input = screen.getByLabelText("API key");
    const save = screen.getByRole("button", { name: "Save" });
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("credential-refusal").textContent).toBe(REFUSAL);

    fireEvent.click(save);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.setApiKeyMutate).not.toHaveBeenCalled();
  });

  it("keeps Clear enabled for a stored key: removing one sends nothing secret", () => {
    mocks.credentialRefusal = REFUSAL;
    render(
      <ProviderApiKeySection
        state={storedKeyState()}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    const clear = screen.getByRole("button", { name: "Clear" });
    expect(clear.hasAttribute("disabled")).toBe(false);

    fireEvent.click(clear);

    expect(mocks.clearApiKeyMutate).toHaveBeenCalledWith({
      providerId: "cursor",
    });
  });

  it("control: on a host that takes keys the same draft is saved by click and by Enter, with no refusal shown", () => {
    render(
      <ProviderApiKeySection
        state={apiKeyState("cursor")}
        draft="sk-secret"
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.queryByTestId("credential-refusal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Enter" });

    expect(mocks.setApiKeyMutate).toHaveBeenCalledTimes(2);
    expect(mocks.setApiKeyMutate).toHaveBeenCalledWith(
      { providerId: "cursor", apiKey: "sk-secret" },
      expect.anything(),
    );
  });
});

describe("ProviderApiKeySection custody sentence", () => {
  const READY: PersonalHostState = {
    kind: "ready",
    status: environmentStatusFixture({}),
  };
  function deviceLine(host: string, provider: string, envName: string) {
    return `Stored encrypted on ${host} only. Other computers and sandboxes running Personal don't get this key. When no key is saved here, ${provider} uses ${envName} from ${host}'s shell.`;
  }
  /** Where Personal does not run, there are no other computers to name. */
  function shortDeviceLine(host: string, provider: string, envName: string) {
    return `Stored encrypted on ${host} only. When no key is saved here, ${provider} uses ${envName} from ${host}'s shell.`;
  }

  function renderOn(
    providerId: ProviderCliState["providerId"],
    hostState: PersonalHostState | null,
  ): void {
    const section = (
      <ProviderApiKeySection
        state={apiKeyState(providerId)}
        draft=""
        onDraftChange={() => undefined}
      />
    );
    render(
      hostState === null ? (
        section
      ) : (
        <PersonalPageContext.Provider
          value={{
            section: "providers",
            pick: PERSONAL_PICK,
            state: hostState,
            line: null,
            hostName: "Studio",
            localOverrides: NO_OVERRIDES,
            hostId: "host-1",
            client: null,
            notices: NO_NOTICES,
            review: NO_REVIEW,
          }}
        >
          {section}
        </PersonalPageContext.Provider>
      ),
    );
  }

  it("states Personal's custody and links how Traycer handles it for a provider whose key becomes Personal's secret", () => {
    renderOn("cursor", READY);

    expect(screen.getByText(SECRET_CUSTODY_SENTENCE)).toBeDefined();
    expect(screen.getByText("How Traycer handles this")).toBeDefined();
    expect(screen.queryByText(/^Stored encrypted on /)).toBeNull();
  });

  it.each([
    [
      "a provider whose key stays on its host (kiro)",
      "kiro",
      READY,
      deviceLine("Studio", "Kiro", "KIRO_API_KEY"),
    ],
    [
      "a page outside Personal (a Local row)",
      "cursor",
      null,
      shortDeviceLine("this computer", "Cursor", "CURSOR_API_KEY"),
    ],
    [
      "a host not running Personal",
      "cursor",
      { kind: "not-set-up" } satisfies PersonalHostState,
      shortDeviceLine("Studio", "Cursor", "CURSOR_API_KEY"),
    ],
  ] as const)(
    "names the one host that keeps the key for %s",
    (_label, id, host, sentence) => {
      renderOn(id, host);

      expect(screen.getByText(sentence)).toBeDefined();
      expect(screen.queryByText(SECRET_CUSTODY_SENTENCE)).toBeNull();
      expect(screen.queryByText("How Traycer handles this")).toBeNull();
    },
  );

  it("a Local row says where the key is kept and never mentions Personal", () => {
    renderOn("cursor", null);

    const line = screen.getByText(/^Stored encrypted on /);
    expect(line.textContent).toBe(
      "Stored encrypted on this computer only. When no key is saved here, Cursor uses CURSOR_API_KEY from this computer's shell.",
    );
    expect(line.textContent).not.toMatch(/Personal/);
  });

  it("names the host even when the saved key came from the shell", () => {
    render(
      <ProviderApiKeySection
        state={{
          ...apiKeyState("kiro"),
          apiKey: { supported: true, configured: true, source: "env" },
        }}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(
      screen.getByText(
        shortDeviceLine("this computer", "Kiro", "KIRO_API_KEY"),
      ),
    ).toBeDefined();
  });
});
