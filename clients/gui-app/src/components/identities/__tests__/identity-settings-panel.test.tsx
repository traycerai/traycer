/**
 * `IdentitySettingsPanel`: one `draft` serves both what the controls display
 * and what Save sends, a `baseline` tracks the last-seeded record, and
 * `remoteChanged` is set only while a DIRTY draft is left standing by a
 * record that moved underneath it.
 *
 * `useOpenIdentityState` is mocked to read from a small real zustand store
 * this suite drives directly (`identityStore`), so changing "what the host
 * published" is a plain `setState` rather than redelivering wire frames
 * through the real lane adapters - the panel's own state machine is what
 * these tests pin, not the replica underneath it.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create, useStore } from "zustand";
import type { IdentityRecordFields } from "@traycer-clients/shared/identity-lanes";
import type { AgentIdentityUpdateRequest } from "@traycer/protocol/host/agent-identity/unary-schemas";
import { IdentitySettingsPanel } from "@/components/identities/identity-settings-panel";

interface MockIdentityState {
  readonly identity: IdentityRecordFields | null;
}

const updateMutate = vi.hoisted(() =>
  vi.fn<(variables: AgentIdentityUpdateRequest) => void>(),
);
const identityStore = create<MockIdentityState>()(() => ({ identity: null }));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({ data: undefined }),
  useGuiHarnessModelsQueryForClient: () => ({ data: undefined }),
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="picker-stub" />,
}));

vi.mock("@/hooks/identities/use-identity-mutations", () => ({
  useIdentityUpdateForClient: () => ({
    mutate: updateMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/identity-selectors", () => ({
  useOpenIdentityState: <T,>(selector: (state: MockIdentityState) => T): T =>
    useStore(identityStore, selector),
}));

function identityA(): IdentityRecordFields {
  return {
    title: "A",
    description: null,
    evolution: {
      intervalTurns: 0,
      reviewHarnessId: "claude",
      reviewModel: "model-a",
      reviewReasoningEffort: null,
    },
  };
}

function identityB(): IdentityRecordFields {
  return {
    title: "A",
    description: null,
    evolution: {
      intervalTurns: 0,
      reviewHarnessId: "claude",
      reviewModel: "model-b",
      reviewReasoningEffort: null,
    },
  };
}

function titleInput(): HTMLInputElement {
  return screen.getByTestId("identity-settings-title") as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  identityStore.setState({ identity: null });
  updateMutate.mockClear();
});

describe("IdentitySettingsPanel - draft vs. baseline", () => {
  it("a clean draft follows the host: saving after the record moved sends the record's own fields", () => {
    identityStore.setState({ identity: identityA() });
    render(<IdentitySettingsPanel identityId="id_1" hostId="host-a" />);

    // The host publishes a different record while the draft is still clean -
    // the draft silently follows it (no notice, no discarded typing yet).
    act(() => {
      identityStore.setState({ identity: identityB() });
    });
    expect(screen.queryByTestId("identity-settings-remote-changed")).toBeNull();

    fireEvent.change(titleInput(), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("identity-settings-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [variables] = updateMutate.mock.calls[0];
    expect(variables.title).toBe("Renamed");
    expect(variables.evolution.reviewModel).toBe("model-b");
  });

  it("a dirty draft is kept when the record moves, and Discard reloads the record's own fields", () => {
    identityStore.setState({ identity: identityA() });
    render(<IdentitySettingsPanel identityId="id_1" hostId="host-a" />);

    fireEvent.change(titleInput(), { target: { value: "Renamed" } });
    expect(titleInput().value).toBe("Renamed");

    // The record moves underneath the now-dirty draft: the typed edit is not
    // discarded, but the panel says so.
    act(() => {
      identityStore.setState({ identity: identityB() });
    });
    expect(
      screen.getByTestId("identity-settings-remote-changed"),
    ).not.toBeNull();
    expect(titleInput().value).toBe("Renamed");

    fireEvent.click(screen.getByTestId("identity-settings-reload"));

    expect(titleInput().value).toBe(identityB().title);
    expect(screen.queryByTestId("identity-settings-remote-changed")).toBeNull();
  });
});
