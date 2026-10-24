// The Link dialog calls `useHostClient()` with no client prop. Mocked at that
// boundary (the way `providers-settings-panel.test.tsx` does), with ONE stable
// scripted client: the poll effect depends on `client`.
const clientMock = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => clientMock.current };
});

// What a link asks the app to open. The call is awaited with `.catch`, so it
// answers a promise.
const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProvidersLinkCompleteRequestV11,
  ProvidersLinkCompleteResponse,
  ProvidersLinkRequestV11,
  ProvidersLinkResponse,
} from "@traycer/protocol/host/environment-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { ProviderLinkDialog } from "@/components/settings/panels/provider-link-dialog";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { OpenLink } from "@/lib/links/open-link";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";

const HOST_ID = "host-link";
const HOST_NAME = "Studio";
const PROFILE_ID = "5f0c9b3e-7a41-4d0e-9c53-0b1f6e2a8d44";
const LINK_ID = "link-1";
const SIGN_IN_URL = "https://claude.ai/oauth/authorize?state=abc";

type LinkHandler = (
  request: ProvidersLinkRequestV11,
) => Promise<ProvidersLinkResponse>;
type CompleteHandler = (
  request: ProvidersLinkCompleteRequestV11,
) => Promise<ProvidersLinkCompleteResponse>;

const linkMock = vi.hoisted(() => ({
  link: vi.fn<LinkHandler>(),
  complete: vi.fn<CompleteHandler>(),
}));

const SIGN_IN_RESPONSE: ProvidersLinkResponse = {
  linkId: LINK_ID,
  prompt: { kind: "sign_in_url", url: SIGN_IN_URL, codePrompt: "Code" },
};
const DEVICE_RESPONSE: ProvidersLinkResponse = {
  linkId: LINK_ID,
  prompt: {
    kind: "device_code",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-1234",
    expiresAt: 1_900_000_000,
  },
};
const HANDOFF_RESPONSE: ProvidersLinkResponse = {
  linkId: LINK_ID,
  prompt: { kind: "local_handoff" },
};

function answer(
  overrides: Partial<ProvidersLinkCompleteResponse>,
): ProvidersLinkCompleteResponse {
  return {
    state: "pending",
    code: null,
    account: null,
    expectedAccount: null,
    ...overrides,
  };
}

function rpcError(
  code: "PROVIDER_LINK_NOT_OFFERED" | "PROVIDER_LINK_UNAVAILABLE" | "RPC_ERROR",
  message: string,
): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "req-1",
    method: "providers.link",
    fatalDetails: null,
  });
}

function personalPage(children: ReactNode): ReactNode {
  return (
    <PersonalPageContext.Provider
      value={{
        section: "providers",
        pick: { kind: "personal" },
        state: { kind: "ready", status: environmentStatusFixture({}) },
        line: null,
        hostName: HOST_NAME,
        localOverrides: [],
        hostId: HOST_ID,
        client: null,
        notices: [],
        review: [],
      }}
    >
      {children}
    </PersonalPageContext.Provider>
  );
}

beforeEach(() => {
  linkMock.link.mockReset();
  linkMock.complete.mockReset();
  openLinkMock.mockReset();
  openLinkMock.mockResolvedValue(undefined);
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.link": linkMock.link,
      "providers.linkComplete": linkMock.complete,
    },
  });
  clientMock.current = client;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clientMock.current = null;
  useProviderLinkDialogStore.setState({ target: null });
});

function openDialog(providerId: string, profileId: string | null): void {
  useProviderLinkDialogStore.getState().open({ providerId, profileId });
  render(personalPage(<ProviderLinkDialog />));
}

function dialogState(): string | null {
  return screen.getByTestId("provider-link-dialog").getAttribute("data-state");
}

async function clickAndSettle(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Opens the dialog and walks it to the sign-in state. */
async function reachSignIn(profileId: string | null): Promise<void> {
  linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
  openDialog("claude-code", profileId);
  fireEvent.click(screen.getByTestId("provider-link-continue"));
  await screen.findByTestId("provider-link-code");
}

function pasteAndLink(code: string): void {
  fireEvent.change(screen.getByTestId("provider-link-code"), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
}

describe("the intro", () => {
  it("shows the plan sentence and starts the link for the profile on Continue", async () => {
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    openDialog("claude-code", PROFILE_ID);

    expect(dialogState()).toBe("intro");
    expect(
      screen.getByText(
        "This signs Traycer in to your plan once. It will be offered on every host and sandbox you use; it counts as a device on your plan.",
      ),
    ).toBeTruthy();
    expect(linkMock.link).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("provider-link-sign-in");

    expect(linkMock.link).toHaveBeenCalledTimes(1);
    expect(linkMock.link).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: null,
    });
  });

  it("starts a new profile's link with a null profile id", async () => {
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    openDialog("claude-code", null);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("provider-link-sign-in");

    expect(linkMock.link).toHaveBeenCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: null,
    });
  });
});

describe("a sign-in URL with a pasted code", () => {
  it("opens the sign-in page, sends the trimmed code and ends on Linked as <account>", async () => {
    await reachSignIn(PROFILE_ID);
    expect(
      screen.getByText("Sign in on claude.ai, then paste the code it shows."),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in on claude.ai" }),
    );
    expect(openLinkMock).toHaveBeenCalledTimes(1);
    expect(openLinkMock).toHaveBeenCalledWith(SIGN_IN_URL, "auth", null);

    // Nothing to send until a code is typed.
    expect(
      screen.getByTestId("provider-link-submit-code").hasAttribute("disabled"),
    ).toBe(true);

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    pasteAndLink("  abc#def  ");
    const linked = await screen.findByTestId("provider-link-linked");

    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(linkMock.complete).toHaveBeenCalledWith({
      linkId: LINK_ID,
      code: "abc#def",
      environmentId: null,
    });
    expect(linked.textContent).toBe("Linked as a@x.test.");
  });

  it("closes and clears the target on Done", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-linked");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });

  it("asks for the whole code when the paste was short, and keeps the code box", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "pending", code: "harness_token_shape" }),
    );
    pasteAndLink("abc");

    const note = await screen.findByTestId("provider-link-code-note");
    expect(note.textContent).toBe("Paste the whole code claude.ai shows.");
    expect(dialogState()).toBe("sign_in");
    expect(screen.getByTestId("provider-link-code")).toBeTruthy();

    // The next paste is judged afresh: the note goes when the code is fine.
    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    pasteAndLink("abc#def");
    await waitFor(() => {
      expect(linkMock.complete).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("provider-link-code-note")).toBeNull();
    });
  });
});

describe("a mismatch", () => {
  async function reachMismatch(profileId: string | null): Promise<void> {
    await reachSignIn(profileId);
    linkMock.complete.mockResolvedValueOnce(
      answer({
        state: "mismatch",
        account: "a@x.test",
        expectedAccount: "b@x.test",
      }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-mismatch");
  }

  it("names both accounts", async () => {
    await reachMismatch(PROFILE_ID);
    expect(screen.getByTestId("provider-link-mismatch").textContent).toBe(
      "You signed in as a@x.test, not b@x.test.",
    );
  });

  it("Retry starts the same profile's link again", async () => {
    await reachMismatch(PROFILE_ID);
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: null,
    });
  });

  it("Add as a new profile starts a link with a null profile id, and keeps it for a later Retry", async () => {
    await reachMismatch(PROFILE_ID);
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);

    fireEvent.click(
      screen.getByRole("button", { name: "Add as a new profile" }),
    );
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: null,
    });

    linkMock.complete.mockResolvedValueOnce(
      answer({
        state: "mismatch",
        account: "a@x.test",
        expectedAccount: null,
      }),
    );
    pasteAndLink("abc#def");
    await screen.findByTestId("provider-link-mismatch");
    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("provider-link-code");

    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: null,
      environmentId: null,
    });
  });
});

describe("a device code", () => {
  async function reachDevice(): Promise<void> {
    vi.useFakeTimers();
    linkMock.link.mockResolvedValueOnce(DEVICE_RESPONSE);
    openDialog("codex", PROFILE_ID);
    await clickAndSettle(screen.getByRole("button", { name: "Continue" }));
  }

  it("shows the code and polls every 5 s until it is linked", async () => {
    await reachDevice();
    expect(dialogState()).toBe("device");
    expect(screen.getByTestId("provider-link-user-code").textContent).toBe(
      "ABCD-1234",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open the sign-in page" }),
    );
    expect(openLinkMock).toHaveBeenCalledWith(
      "https://auth.example.test/device",
      "auth",
      null,
    );

    // Nothing is asked before the first beat.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(linkMock.complete).not.toHaveBeenCalled();

    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(linkMock.complete).toHaveBeenLastCalledWith({
      linkId: LINK_ID,
      code: null,
      environmentId: null,
    });
    expect(dialogState()).toBe("device");

    // A pending answer keeps the same state and still arms the next poll.
    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(2);
    expect(dialogState()).toBe("device");

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "dev@x.test" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("provider-link-linked").textContent).toBe(
      "Linked as dev@x.test.",
    );

    // Settled: no further polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(3);
  });

  it("stops polling once the dialog is cancelled", async () => {
    await reachDevice();
    linkMock.complete.mockResolvedValue(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);

    await clickAndSettle(screen.getByRole("button", { name: "Cancel" }));
    expect(useProviderLinkDialogStore.getState().target).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
  });

  it("shows the expired line when the code expires, with Reconnect", async () => {
    await reachDevice();
    linkMock.complete.mockResolvedValueOnce(answer({ state: "expired" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId("provider-link-expired").textContent).toBe(
      "This sign-in expired.",
    );
    linkMock.link.mockResolvedValueOnce(DEVICE_RESPONSE);
    await clickAndSettle(screen.getByRole("button", { name: "Reconnect" }));
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "codex",
      profileId: PROFILE_ID,
      environmentId: null,
    });
    expect(dialogState()).toBe("device");
  });

  it("falls to the unavailable line when a poll is refused", async () => {
    await reachDevice();
    linkMock.complete.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_UNAVAILABLE", "offline detail"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId("provider-link-unavailable")).toBeTruthy();
  });
});

describe("a local handoff", () => {
  it("shows Linking…, polls every 2 s, then Linked", async () => {
    vi.useFakeTimers();
    linkMock.link.mockResolvedValueOnce(HANDOFF_RESPONSE);
    openDialog("claude-code", PROFILE_ID);
    await clickAndSettle(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByTestId("provider-link-linking").textContent).toBe(
      "Linking…",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(linkMock.complete).not.toHaveBeenCalled();

    linkMock.complete.mockResolvedValueOnce(answer({ state: "pending" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(1);
    expect(linkMock.complete).toHaveBeenLastCalledWith({
      linkId: LINK_ID,
      code: null,
      environmentId: null,
    });
    expect(dialogState()).toBe("linking");

    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "linked", account: "a@x.test" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(linkMock.complete).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("provider-link-linked").textContent).toBe(
      "Linked as a@x.test.",
    );
  });
});

describe("an expired sign-in", () => {
  it("says so and Reconnect starts the profile's link again", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(answer({ state: "expired" }));
    pasteAndLink("abc#def");

    const expired = await screen.findByTestId("provider-link-expired");
    expect(expired.textContent).toBe("This sign-in expired.");

    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await screen.findByTestId("provider-link-code");
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: null,
    });
  });
});

describe("a refused start", () => {
  it("says the profile is on this host only, and shows none of the error's text", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_NOT_OFFERED", "internal-detail-xyz"),
    );
    openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-not-offered");
    expect(line.textContent).toBe("On Studio only.");
    expect(screen.queryByText(/internal-detail-xyz/)).toBeNull();
    // Nothing left to start: the only way on is to close.
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("names this host generically outside a Personal page", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_NOT_OFFERED", "internal-detail-xyz"),
    );
    useProviderLinkDialogStore
      .getState()
      .open({ providerId: "claude-code", profileId: PROFILE_ID });
    render(<ProviderLinkDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-not-offered");
    expect(line.textContent).toBe("On this host only.");
  });

  it("asks to connect to Traycer when it is unavailable, and Retry tries again", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("PROVIDER_LINK_UNAVAILABLE", "internal-detail-xyz"),
    );
    openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-unavailable");
    expect(line.textContent).toBe("Connect to Traycer to link this profile.");
    expect(screen.queryByText(/internal-detail-xyz/)).toBeNull();

    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("provider-link-code");
    expect(linkMock.link).toHaveBeenCalledTimes(2);
    expect(linkMock.link).toHaveBeenLastCalledWith({
      providerId: "claude-code",
      profileId: PROFILE_ID,
      environmentId: null,
    });
  });

  it("shows another error's message as the failed line", async () => {
    linkMock.link.mockRejectedValueOnce(
      rpcError("RPC_ERROR", "the keychain is locked"),
    );
    openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-failed");
    expect(line.textContent).toBe("the keychain is locked");
  });

  it("explains a missing local sign-in when the link fails with no_sign_in", async () => {
    await reachSignIn(PROFILE_ID);
    linkMock.complete.mockResolvedValueOnce(
      answer({ state: "failed", code: "no_sign_in" }),
    );
    pasteAndLink("abc#def");

    const line = await screen.findByTestId("provider-link-failed");
    expect(line.textContent).toBe(
      "Sign in to this profile on this computer first, then link it.",
    );
  });
});

describe("a provider the dialog does not know", () => {
  it("says the profile is on this host only and never calls the host", async () => {
    openDialog("nope", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const line = await screen.findByTestId("provider-link-not-offered");
    expect(line.textContent).toBe("On Studio only.");
    expect(linkMock.link).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("clears the store target on Cancel", () => {
    openDialog("claude-code", PROFILE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();
  });

  it("reopens at the intro with no code typed", async () => {
    await reachSignIn(PROFILE_ID);
    fireEvent.change(screen.getByTestId("provider-link-code"), {
      target: { value: "half-typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("provider-link-dialog")).toBeNull();

    act(() => {
      useProviderLinkDialogStore
        .getState()
        .open({ providerId: "claude-code", profileId: PROFILE_ID });
    });
    expect(dialogState()).toBe("intro");
    expect(screen.queryByTestId("provider-link-code")).toBeNull();

    linkMock.link.mockResolvedValueOnce(SIGN_IN_RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const box = await screen.findByTestId("provider-link-code");
    expect(box instanceof HTMLInputElement ? box.value : null).toBe("");
  });
});
