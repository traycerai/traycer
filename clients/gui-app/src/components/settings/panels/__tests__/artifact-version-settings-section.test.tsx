import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactVersionSettingsCommandResponse,
  ArtifactVersionSettingsGetResponse,
} from "@traycer/protocol/host/epic/artifact-versions";

interface MutationConfig {
  readonly method: string;
  readonly onSuccess?: (
    data: Readonly<Record<string, unknown>>,
    variables: Readonly<Record<string, unknown>>,
  ) => void;
}

const state = vi.hoisted(() => ({
  supportedMethods: new Set<string>(),
  supportCalls: [] as string[],
  mutationCalls: [] as Array<{
    readonly method: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }>,
  mutationOnSuccessByMethod: new Map<
    string,
    (
      data: Readonly<Record<string, unknown>>,
      variables: Readonly<Record<string, unknown>>,
    ) => void
  >(),
  snapshot: {
    settings: {
      enabled: true,
      retentionDays: 30,
      maxVersionsPerArtifact: 100,
      maxBytesPerArtifact: 16 * 1024 * 1024,
    },
    storage: {
      referencedBytes: 2 * 1024 * 1024,
      reclaimableBytes: 1024 * 1024,
    },
  } satisfies ArtifactVersionSettingsGetResponse,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string | null, method: string) => {
    state.supportCalls.push(method);
    return state.supportedMethods.has(method);
  },
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({
    data: state.snapshot,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (_client: null, config: MutationConfig) => {
    if (config.onSuccess !== undefined) {
      state.mutationOnSuccessByMethod.set(config.method, config.onSuccess);
    }
    return {
      isPending: false,
      mutate: (variables: Readonly<Record<string, unknown>>) => {
        state.mutationCalls.push({ method: config.method, variables });
      },
    };
  },
}));

import { ArtifactVersionSettingsSection } from "../artifact-version-settings-section";

const SETTINGS_METHODS = [
  "epic.artifactVersionSettings.get",
  "epic.artifactVersionSettings.setEnabled",
  "epic.artifactVersionSettings.setRetentionPolicy",
  "epic.artifactVersionSettings.clearHistory",
] as const;

function renderSettings(): void {
  render(
    <ArtifactVersionSettingsSection client={null} hostId="host-a" enabled />,
  );
}

describe("<ArtifactVersionSettingsSection />", () => {
  beforeEach(() => {
    state.supportedMethods = new Set(SETTINGS_METHODS);
    state.supportCalls = [];
    state.mutationCalls = [];
    state.mutationOnSuccessByMethod = new Map();
    state.snapshot = {
      settings: {
        enabled: true,
        retentionDays: 30,
        maxVersionsPerArtifact: 100,
        maxBytesPerArtifact: 16 * 1024 * 1024,
      },
      storage: {
        referencedBytes: 2 * 1024 * 1024,
        reclaimableBytes: 1024 * 1024,
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("stays hidden unless every settings command was negotiated", () => {
    state.supportedMethods.delete("epic.artifactVersionSettings.clearHistory");

    renderSettings();

    expect(state.supportCalls).toEqual(SETTINGS_METHODS);
    expect(screen.queryByTestId("artifact-version-settings")).toBeNull();
  });

  it("shows referenced and reclaimable storage without conflating them", () => {
    renderSettings();

    expect(screen.getByText("2.0 MB referenced")).toBeTruthy();
    expect(screen.getByText("1.0 MB reclaimable")).toBeTruthy();
  });

  it("can clear version records when checkpoint ownership leaves no reclaimable bytes", () => {
    state.snapshot = {
      ...state.snapshot,
      storage: {
        referencedBytes: 2 * 1024 * 1024,
        reclaimableBytes: 0,
      },
    };

    renderSettings();

    const clearButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Clear version history…",
    });
    expect(clearButton.disabled).toBe(false);
  });

  it("explains each destructive settings confirmation before mutation", () => {
    renderSettings();

    fireEvent.click(
      screen.getByRole("switch", { name: "Capture artifact versions" }),
    );
    expect(
      screen.getByRole("heading", { name: "Turn off version history?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Edits made while history is off are never recoverable\./u,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Existing saved versions remain available\./u),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.change(screen.getByLabelText("Days"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    expect(
      screen.getByRole("heading", { name: "Tighten retention?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Observations beyond the new age, version-count, or per-artifact byte limits will be pruned immediately. This cannot be undone.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Clear version history…" }),
    );
    expect(
      screen.getByRole("heading", { name: "Clear version history?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "1.0 MB is reclaimable and will be removed. Checkpoint-owned blobs remain because checkpoints still reference them.",
      ),
    ).toBeTruthy();
    expect(state.mutationCalls).toEqual([]);
  });

  it("keeps a non-mebibyte host byte cap when only days change", () => {
    state.snapshot = {
      ...state.snapshot,
      settings: {
        ...state.snapshot.settings,
        maxBytesPerArtifact: 1_500_000,
      },
    };

    renderSettings();

    fireEvent.change(screen.getByLabelText("Days"), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    fireEvent.click(screen.getByRole("button", { name: "Prune and save" }));

    expect(state.mutationCalls).toEqual([
      {
        method: "epic.artifactVersionSettings.setRetentionPolicy",
        variables: {
          retentionDays: 14,
          maxVersionsPerArtifact: 100,
          maxBytesPerArtifact: 1_500_000,
        },
      },
    ]);
  });

  it("uses the three narrow settings commands", () => {
    renderSettings();

    fireEvent.click(
      screen.getByRole("switch", { name: "Capture artifact versions" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    fireEvent.change(screen.getByLabelText("Days"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    fireEvent.click(screen.getByRole("button", { name: "Prune and save" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Clear version history…" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear reclaimable history" }),
    );

    expect(state.mutationCalls).toEqual([
      {
        method: "epic.artifactVersionSettings.setEnabled",
        variables: { enabled: false },
      },
      {
        method: "epic.artifactVersionSettings.setRetentionPolicy",
        variables: {
          retentionDays: 7,
          maxVersionsPerArtifact: 100,
          maxBytesPerArtifact: 16 * 1024 * 1024,
        },
      },
      {
        method: "epic.artifactVersionSettings.clearHistory",
        variables: {},
      },
    ]);
  });

  it("shows the command banner on mutation success and defers to a later query result for the storage row", () => {
    const { rerender } = render(
      <ArtifactVersionSettingsSection client={null} hostId="host-a" enabled />,
    );

    fireEvent.change(screen.getByLabelText("Days"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    fireEvent.click(screen.getByRole("button", { name: "Prune and save" }));

    const onSuccess = state.mutationOnSuccessByMethod.get(
      "epic.artifactVersionSettings.setRetentionPolicy",
    );
    if (onSuccess === undefined) {
      throw new Error("setRetentionPolicy mutation never registered onSuccess");
    }
    const commandResponse = {
      settings: {
        enabled: true,
        retentionDays: 7,
        maxVersionsPerArtifact: 100,
        maxBytesPerArtifact: 16 * 1024 * 1024,
      },
      storage: {
        referencedBytes: 2 * 1024 * 1024,
        reclaimableBytes: 512 * 1024,
      },
      effects: {
        captureStopped: false,
        captureResumed: false,
        driftEpicIds: [],
        observationsPruned: 3,
        contentRowsPruned: 3,
        blobsDeleted: 1,
        bytesDeleted: 512 * 1024,
      },
    } satisfies ArtifactVersionSettingsCommandResponse;
    act(() => {
      onSuccess(commandResponse, {
        retentionDays: 7,
        maxVersionsPerArtifact: 100,
        maxBytesPerArtifact: 16 * 1024 * 1024,
      });
    });

    expect(
      screen.getByText(/3 observations pruned; 512\.0 KB reclaimed\./u),
    ).toBeTruthy();

    state.snapshot = {
      settings: {
        enabled: true,
        retentionDays: 7,
        maxVersionsPerArtifact: 100,
        maxBytesPerArtifact: 16 * 1024 * 1024,
      },
      storage: {
        referencedBytes: 2 * 1024 * 1024,
        reclaimableBytes: 256 * 1024,
      },
    };
    rerender(
      <ArtifactVersionSettingsSection client={null} hostId="host-a" enabled />,
    );

    expect(screen.getByText("256.0 KB reclaimable")).toBeTruthy();
    expect(
      screen.getByText(/3 observations pruned; 512\.0 KB reclaimed\./u),
    ).toBeTruthy();
  });
});
