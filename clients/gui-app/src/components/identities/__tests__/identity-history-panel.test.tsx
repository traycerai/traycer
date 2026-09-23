/**
 * `IdentityHistoryPanel`: the restore flow always goes
 * preflight -> confirm -> execute, fenced by the preflight's own
 * `currentHash`. The list query and the two mutations are faked; the
 * component's own state machine (opening the confirm dialog, wiring the
 * preflight response into the execute call) is what this suite pins.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentIdentityHistoryRestoreRequest,
  AgentIdentityHistoryRestoreResponse,
  AgentIdentityVersionEntry,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import { IdentityHistoryPanel } from "@/components/identities/identity-history-panel";

interface RestoreMutateOptions {
  readonly onSuccess: (response: AgentIdentityHistoryRestoreResponse) => void;
  readonly onError?: () => void;
}

const mocks = vi.hoisted(() => ({
  restoreMutate:
    vi.fn<
      (
        variables: AgentIdentityHistoryRestoreRequest,
        options: RestoreMutateOptions,
      ) => void
    >(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

function versionEntry(
  observationId: string,
  overrides: Partial<AgentIdentityVersionEntry>,
): AgentIdentityVersionEntry {
  return {
    observationId,
    contentHash: "a".repeat(64),
    serializerVersion: 1,
    parentContentHash: null,
    provenance: { kind: "remote_merge" },
    captureStreamId: "stream-1",
    localSeq: 1,
    capturedAt: 1000,
    available: true,
    degraded: false,
    ...overrides,
  };
}

const NEWEST = versionEntry("obs-newest", { capturedAt: 2000 });
const OLDER = versionEntry("obs-older", { capturedAt: 1000 });

vi.mock("@/hooks/identities/use-identity-queries", () => ({
  IDENTITY_HISTORY_PAGE_SIZE: 200,
  useIdentityHistoryListForClient: () => ({
    data: { entries: [NEWEST, OLDER], nextCursor: null },
    isError: false,
  }),
}));

vi.mock("@/hooks/identities/use-identity-mutations", () => ({
  useIdentityHistoryLoadOlderForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useIdentityHistoryRestoreForClient: () => ({
    mutate: mocks.restoreMutate,
    isPending: false,
  }),
}));

describe("IdentityHistoryPanel - restore flow", () => {
  afterEach(() => {
    cleanup();
    mocks.restoreMutate.mockClear();
  });

  it("clicking Restore on the older entry requests a preflight, then executes with the preflight's hash after confirming", () => {
    render(<IdentityHistoryPanel identityId="identity_1" path="SOUL.md" />);

    // Only the OLDER entry (not the newest/current one) offers a Restore button.
    const restoreButtons = screen.getAllByTestId("identity-history-restore");
    expect(restoreButtons).toHaveLength(1);
    fireEvent.click(restoreButtons[0]);

    expect(mocks.restoreMutate).toHaveBeenCalledTimes(1);
    const [preflightVariables, preflightOptions] =
      mocks.restoreMutate.mock.calls[0];
    expect(preflightVariables).toEqual({
      identityId: "identity_1",
      path: "SOUL.md",
      targetObservationId: "obs-older",
      mode: "preflight",
      expectedCurrentHash: null,
    });

    // Simulate the host answering the preflight request.
    act(() => {
      preflightOptions.onSuccess({
        kind: "preflight",
        currentHash: "b".repeat(64),
        imagesMissing: [],
        threadCount: 0,
      });
    });

    // Confirm the dialog - the button labelled "Restore" inside it.
    const confirmButton = screen.getByTestId("confirm-action");
    fireEvent.click(confirmButton);

    expect(mocks.restoreMutate).toHaveBeenCalledTimes(2);
    const [executeVariables] = mocks.restoreMutate.mock.calls[1];
    expect(executeVariables).toEqual({
      identityId: "identity_1",
      path: "SOUL.md",
      targetObservationId: "obs-older",
      mode: "execute",
      expectedCurrentHash: "b".repeat(64),
    });
  });
});
