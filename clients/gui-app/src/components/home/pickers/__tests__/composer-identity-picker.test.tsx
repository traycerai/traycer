/**
 * `<ComposerIdentityPicker />` acceptance: picking/clearing an identity
 * commits it to the toolbar store's tuple, the control hides on a host that
 * doesn't serve `agentIdentity.list` (or with no host at all), and the
 * removed/unresolved states render the right affordances. Only the host
 * boundary is mocked (`use-host-supports-method`, `use-host-client-for-host-id`,
 * `use-identity-queries`); the toolbar store and the Identities dialog store
 * are the real modules.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerIdentityPicker } from "@/components/home/pickers/composer-identity-picker";
import {
  createComposerToolbarStore,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const mocks = vi.hoisted(() => ({
  hostSupportsMethod: true,
  identityListResult: {
    data: undefined as
      | { readonly identities: ReadonlyArray<AgentIdentitySummary> }
      | undefined,
    isError: false,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.hostSupportsMethod,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/identities/use-identity-queries", () => ({
  useIdentityListForClient: () => mocks.identityListResult,
}));

const IDENTITY_A: AgentIdentitySummary = {
  identityId: "id-a",
  title: "Assistant A",
  description: null,
  updatedAt: 1,
};
const IDENTITY_B: AgentIdentitySummary = {
  identityId: "id-b",
  title: "Assistant B",
  description: null,
  updatedAt: 2,
};

function createStore(
  identityId: string | null,
  onSettingsChange: ((settings: ChatRunSettings) => void) | null,
): ComposerToolbarStore {
  // A non-empty, non-catalog-checked model slug so the emit gate
  // (`settings.model.length === 0`) never defers an identity edit here - the
  // deferral path itself is covered in
  // `stores/composer/__tests__/composer-toolbar-identity.test.ts`.
  return createComposerToolbarStore({
    seedKey: "seed-identity",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "sonnet-4.5",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
      identityId,
    },
    onSettingsChange,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: "host-1",
  });
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByTestId("composer-identity-trigger"), {
    button: 0,
  });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mocks.hostSupportsMethod = true;
  mocks.identityListResult = { data: undefined, isError: false };
  useDesktopDialogStore.setState({
    activeDialog: null,
    identitiesRequest: { hostId: null, mode: "list" },
  });
});

describe("<ComposerIdentityPicker /> - visibility gate", () => {
  it("renders nothing when the host does not support agentIdentity.list", () => {
    mocks.hostSupportsMethod = false;
    const store = createStore(null, null);

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );

    expect(screen.queryByTestId("composer-identity-trigger")).toBeNull();
  });

  it("renders nothing with no host id, even when the method is supported", () => {
    const store = createStore(null, null);

    render(
      <ComposerIdentityPicker store={store} hostId={null} disabled={false} />,
    );

    expect(screen.queryByTestId("composer-identity-trigger")).toBeNull();
  });
});

describe("<ComposerIdentityPicker /> - picking commits the tuple", () => {
  it("picking an identity sets the store's identityId and emits it on the settings tuple", () => {
    const emitted: ChatRunSettings[] = [];
    mocks.identityListResult = {
      data: { identities: [IDENTITY_A, IDENTITY_B] },
      isError: false,
    };
    const store = createStore(null, (settings) => emitted.push(settings));

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );
    openMenu();
    const option = screen
      .getAllByTestId("composer-identity-option")
      .find((element) => element.getAttribute("data-identity-id") === "id-a");
    if (option === undefined) throw new Error("expected the id-a option");
    fireEvent.click(option);

    expect(store.getState().identityId).toBe("id-a");
    expect(emitted.at(-1)?.identityId).toBe("id-a");
  });

  it("selecting None clears the identity and emits null", () => {
    const emitted: ChatRunSettings[] = [];
    mocks.identityListResult = {
      data: { identities: [IDENTITY_A] },
      isError: false,
    };
    const store = createStore("id-a", (settings) => emitted.push(settings));

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );
    openMenu();
    fireEvent.click(screen.getByTestId("composer-identity-option-none"));

    expect(store.getState().identityId).toBeNull();
    expect(emitted.at(-1)?.identityId).toBeNull();
  });
});

describe("<ComposerIdentityPicker /> - removed state", () => {
  it("shows the removed state with a clear button when the loaded list no longer returns the chat's identity", () => {
    mocks.identityListResult = {
      data: { identities: [IDENTITY_B] },
      isError: false,
    };
    const store = createStore("id-a", null);

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );

    const trigger = screen.getByTestId("composer-identity-trigger");
    expect(trigger.getAttribute("data-identity-state")).toBe("removed");
    expect(screen.getByText("Removed")).toBeTruthy();
    expect(screen.getByTestId("composer-identity-clear")).toBeTruthy();
  });

  it("clicking the clear button removes the identity and emits null", () => {
    const emitted: ChatRunSettings[] = [];
    mocks.identityListResult = {
      data: { identities: [IDENTITY_B] },
      isError: false,
    };
    const store = createStore("id-a", (settings) => emitted.push(settings));

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );
    fireEvent.click(screen.getByTestId("composer-identity-clear"));

    expect(store.getState().identityId).toBeNull();
    expect(emitted.at(-1)?.identityId).toBeNull();
  });
});

describe("<ComposerIdentityPicker /> - unresolved state", () => {
  it("shows the unresolved state with no clear button while the list is still loading", () => {
    // mocks.identityListResult.data stays undefined from beforeEach - "still loading".
    const store = createStore("id-a", null);

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );

    const trigger = screen.getByTestId("composer-identity-trigger");
    expect(trigger.getAttribute("data-identity-state")).toBe("unresolved");
    expect(screen.queryByTestId("composer-identity-clear")).toBeNull();
  });
});

describe("<ComposerIdentityPicker /> - New identity / Manage identities", () => {
  it("New identity opens the Identities dialog in create mode, naming the composer's host", () => {
    const store = createStore(null, null);

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );
    openMenu();
    fireEvent.click(screen.getByTestId("composer-identity-new"));

    expect(useDesktopDialogStore.getState().activeDialog).toBe("identities");
    expect(useDesktopDialogStore.getState().identitiesRequest).toEqual({
      hostId: "host-1",
      mode: "create",
    });
  });

  it("Manage identities opens the Identities dialog in list mode, naming the composer's host", () => {
    const store = createStore(null, null);

    render(
      <ComposerIdentityPicker store={store} hostId="host-1" disabled={false} />,
    );
    openMenu();
    fireEvent.click(screen.getByTestId("composer-identity-manage"));

    expect(useDesktopDialogStore.getState().activeDialog).toBe("identities");
    expect(useDesktopDialogStore.getState().identitiesRequest).toEqual({
      hostId: "host-1",
      mode: "list",
    });
  });
});
