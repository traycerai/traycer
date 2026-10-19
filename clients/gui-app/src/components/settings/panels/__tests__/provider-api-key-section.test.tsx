import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";

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
