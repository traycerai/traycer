import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";
import { apiKeyState } from "./provider-api-key-section-fixture";
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
  setExpectedEnvironmentIds: new Array<string | null>(),
  clearExpectedEnvironmentIds: new Array<string | null>(),
  /** What `useHostCredentialRefusal` answers; `null` is a host that takes keys. */
  credentialRefusal: null as string | null,
}));
const openLink = mocks.openLink;

vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: (expectedEnvironmentId: string | null) => {
    mocks.setExpectedEnvironmentIds.push(expectedEnvironmentId);
    return { mutate: mocks.setApiKeyMutate, isPending: false };
  },
}));

vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: (expectedEnvironmentId: string | null) => {
    mocks.clearExpectedEnvironmentIds.push(expectedEnvironmentId);
    return { mutate: mocks.clearApiKeyMutate, isPending: false };
  },
}));

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => mocks.credentialRefusal,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLink,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
  mocks.setExpectedEnvironmentIds.length = 0;
  mocks.clearExpectedEnvironmentIds.length = 0;
});

function UnscopedProviderApiKeySection(props: {
  readonly state: ProviderCliState;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
}): ReactNode {
  return (
    <ProviderApiKeySection
      {...props}
      expectedEnvironmentId={null}
      environmentName={null}
    />
  );
}

describe("ProviderApiKeySection dashboard link", () => {
  it("renders the key field without a 'get a key' button when the dashboard URL is null (kiro)", () => {
    // Kiro takes a KIRO_API_KEY but has no stable public key page. The total
    // Record marks that omission with null rather than silently dropping the
    // button the way a Partial record did for any missing entry.
    render(
      <UnscopedProviderApiKeySection
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
      <UnscopedProviderApiKeySection
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
      <UnscopedProviderApiKeySection
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
      <UnscopedProviderApiKeySection
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
      <UnscopedProviderApiKeySection
        state={apiKeyState("cursor")}
        draft="sk-secret"
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.queryByTestId("credential-refusal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Enter" });

    const calls = mocks.setApiKeyMutate.mock.calls;
    const firstCall = calls.at(0);
    const secondCall = calls.at(1);
    expect(
      calls.length === 2 &&
        firstCall !== undefined &&
        secondCall !== undefined &&
        firstCall[0].providerId === "cursor" &&
        firstCall[0].apiKey === "sk-secret" &&
        secondCall[0].apiKey === "sk-secret",
    ).toBe(true);
  });
});

describe("ProviderApiKeySection on a key that belongs to another vendor", () => {
  const ANTHROPIC_KEY = "sk-ant-api03-clearly-fake-test-key-do-not-use";
  const OPENROUTER_KEY = "sk-or-v1-clearly-fake-test-key-do-not-use";
  const FOREIGN_KEY_REFUSAL =
    'This looks like an Anthropic key, not an OpenRouter key. OpenRouter keys start with "sk-or-".';

  it("shows the refusal beside the field, disables Save and sends nothing by click or by Enter", () => {
    render(
      <UnscopedProviderApiKeySection
        state={apiKeyState("openrouter")}
        draft={ANTHROPIC_KEY}
        onDraftChange={() => undefined}
      />,
    );

    const input = screen.getByLabelText("API key");
    const save = screen.getByRole("button", { name: "Save" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(FOREIGN_KEY_REFUSAL);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(save.hasAttribute("disabled")).toBe(true);
    // The field stays editable so the person can replace the key.
    expect(input.hasAttribute("disabled")).toBe(false);

    fireEvent.click(save);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.setApiKeyMutate).not.toHaveBeenCalled();
  });

  it("control: the vendor's own key and a key of no recognizable shape are saved, with no refusal", () => {
    for (const draft of [OPENROUTER_KEY, "unrecognized-shape-fake-key"]) {
      mocks.setApiKeyMutate.mockClear();
      const { unmount } = render(
        <UnscopedProviderApiKeySection
          state={apiKeyState("openrouter")}
          draft={draft}
          onDraftChange={() => undefined}
        />,
      );

      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByLabelText("API key").getAttribute("aria-invalid"),
      ).toBe("false");
      fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Enter" });
      const savedCall = mocks.setApiKeyMutate.mock.calls.at(0);
      expect(
        mocks.setApiKeyMutate.mock.calls.length === 1 &&
          savedCall !== undefined &&
          savedCall[0].providerId === "openrouter" &&
          savedCall[0].apiKey === draft,
      ).toBe(true);
      unmount();
    }
  });
  it("shows the refusal a saved foreign key carries on an empty or blank draft, and a valid replacement clears it and saves", () => {
    // An opaque pass-through from the host's own auth.detail, unrelated to
    // providerApiKeyRefusal's wording: the component renders it as-is.
    const SAVED_KEY_AUTH_DETAIL =
      "The host refused this key: unrecognized issuer.";
    const savedForeign: ProviderCliState = {
      ...apiKeyState("openrouter"),
      apiKey: { supported: true, configured: true, source: "stored" },
      auth: {
        status: "unauthenticated",
        badgeText: null,
        label: null,
        detail: SAVED_KEY_AUTH_DETAIL,
      },
    };
    const { rerender } = render(
      <UnscopedProviderApiKeySection
        state={savedForeign}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(SAVED_KEY_AUTH_DETAIL);
    expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(alert.id).toBe(
      screen.getByLabelText("API key").getAttribute("aria-describedby"),
    );

    rerender(
      <UnscopedProviderApiKeySection
        state={savedForeign}
        draft="   "
        onDraftChange={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(SAVED_KEY_AUTH_DETAIL);

    rerender(
      <UnscopedProviderApiKeySection
        state={savedForeign}
        draft={OPENROUTER_KEY}
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("API key").getAttribute("aria-invalid")).toBe(
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "Enter" });
    const savedCall = mocks.setApiKeyMutate.mock.calls.at(0);
    expect(
      mocks.setApiKeyMutate.mock.calls.length === 1 &&
        savedCall !== undefined &&
        savedCall[0].providerId === "openrouter" &&
        savedCall[0].apiKey === OPENROUTER_KEY,
    ).toBe(true);
  });

  it("control: a saved key that is merely unauthenticated without a refusal shows no alert", () => {
    render(
      <UnscopedProviderApiKeySection
        state={{
          ...apiKeyState("openrouter"),
          apiKey: { supported: true, configured: true, source: "stored" },
          auth: {
            status: "unauthenticated",
            badgeText: null,
            label: null,
            detail: null,
          },
        }}
        draft=""
        onDraftChange={() => undefined}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
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

  function renderPersonal(
    section: ReactNode,
    hostState: PersonalHostState,
  ): void {
    render(
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
      </PersonalPageContext.Provider>,
    );
  }

  function renderOn(
    providerId: ProviderCliState["providerId"],
    hostState: PersonalHostState | null,
  ): void {
    const section = (
      <UnscopedProviderApiKeySection
        state={apiKeyState(providerId)}
        draft=""
        onDraftChange={() => undefined}
      />
    );
    if (hostState === null) {
      render(section);
      return;
    }
    renderPersonal(section, hostState);
  }

  function renderRecorded(
    providerId: ProviderCliState["providerId"],
    environmentName: string,
    personal: boolean,
  ): void {
    const environmentId = "environment-recorded";
    const state: ProviderCliState = {
      ...apiKeyState(providerId),
      apiKey: {
        supported: true,
        configured: true,
        source: "stored",
        recordEnvironmentId: environmentId,
      },
    };
    const section = (
      <ProviderApiKeySection
        state={state}
        draft=""
        onDraftChange={() => undefined}
        expectedEnvironmentId={environmentId}
        environmentName={environmentName}
      />
    );
    if (personal) {
      renderPersonal(section, READY);
      return;
    }
    render(section);
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
      <UnscopedProviderApiKeySection
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

  it.each(["cursor", "openrouter", "huggingface", "amp"] as const)(
    "shows the Personal record custody notice for %s",
    (providerId) => {
      renderRecorded(providerId, "Personal", true);

      expect(
        screen.getByText(
          "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.",
        ),
      ).toBeDefined();
      expect(screen.getByText("How Traycer handles this")).toBeDefined();
    },
  );

  it("shows team record custody without the Personal data-handling notice", () => {
    renderRecorded("cursor", "Acme", false);

    expect(
      screen.getByText(
        "Stored encrypted in Traycer's cloud. Computers running Acme receive the value, readable by their tools and agents; sandboxes use it without seeing it.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("How Traycer handles this")).toBeNull();
    expect(screen.queryByText(/Personal/)).toBeNull();
  });

  it.each(["kiro", "droid"] as const)(
    "keeps %s record keys host-scoped without the Personal notice",
    (providerId) => {
      renderRecorded(providerId, "Personal", true);

      expect(
        screen.getByText(
          "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents.",
        ),
      ).toBeDefined();
      expect(screen.queryByText("How Traycer handles this")).toBeNull();
    },
  );

  it.each(["absent", "null"] as const)(
    "keeps the legacy host and shell lines when recordEnvironmentId is %s",
    (fact) => {
      const state: ProviderCliState = {
        ...apiKeyState("cursor"),
        apiKey:
          fact === "null"
            ? {
                supported: true,
                configured: true,
                source: "env",
                recordEnvironmentId: null,
              }
            : { supported: true, configured: true, source: "env" },
      };
      render(
        <UnscopedProviderApiKeySection
          state={state}
          draft=""
          onDraftChange={() => undefined}
        />,
      );

      expect(
        screen.getByText(
          "Using CURSOR_API_KEY from your shell. Save a key here to override it.",
        ),
      ).toBeDefined();
      expect(
        screen.getByText(
          shortDeviceLine("this computer", "Cursor", "CURSOR_API_KEY"),
        ),
      ).toBeDefined();
      expect(
        screen.queryByText(/Stored encrypted in Traycer's cloud/),
      ).toBeNull();
    },
  );
});
