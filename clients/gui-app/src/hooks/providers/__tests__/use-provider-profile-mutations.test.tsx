import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { RenameProviderProfileRequest } from "@/hooks/providers/use-rename-provider-profile-mutation";
import type { RecolorProviderProfileRequest } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import type { RemoveProviderProfileRequest } from "@/hooks/providers/use-remove-provider-profile-mutation";
import type { AcknowledgeAmbientDriftRequest } from "@/hooks/providers/use-acknowledge-ambient-drift-mutation";

type SetEnabledRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;

interface CapturedRenameMutation {
  readonly mapVariables: (
    variables: RenameProviderProfileRequest,
  ) => SetEnabledRequest;
}

interface CapturedRemoveMutation {
  readonly mapVariables: (
    variables: RemoveProviderProfileRequest,
  ) => SetEnabledRequest;
}

interface CapturedRecolorMutation {
  readonly mapVariables: (
    variables: RecolorProviderProfileRequest,
  ) => SetEnabledRequest;
}

interface CapturedAcknowledgeAmbientDriftMutation {
  readonly mapVariables: (
    variables: AcknowledgeAmbientDriftRequest,
  ) => SetEnabledRequest;
}

const mocks = vi.hoisted(() => ({
  client: {
    getActiveHostId: vi.fn(() => "host-1"),
    request: vi.fn(),
  },
  useHostMutation: vi.fn(),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: mocks.useHostMutation,
}));

import { useRemoveProviderProfile } from "@/hooks/providers/use-remove-provider-profile-mutation";
import { useRecolorProviderProfile } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRenameProviderProfile } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useAcknowledgeAmbientDrift } from "@/hooks/providers/use-acknowledge-ambient-drift-mutation";

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("provider profile mutation wrappers", () => {
  it("maps rename to providers.setEnabled profileAction", () => {
    let captured: CapturedRenameMutation | null = null;
    const getCaptured = (): CapturedRenameMutation => {
      if (captured === null) throw new Error("Mutation was not captured.");
      return captured;
    };
    mocks.useHostMutation.mockImplementation((args: CapturedRenameMutation) => {
      captured = args;
      return { mutate: vi.fn(), isPending: false, error: null };
    });

    renderHook(() => useRenameProviderProfile(), { wrapper });

    expect(
      getCaptured().mapVariables({
        providerId: "codex",
        profileId: "profile-1",
        label: "Work",
      }),
    ).toEqual({
      providerId: "codex",
      enabled: true,
      native: null,
      profileAction: {
        type: "rename",
        profileId: "profile-1",
        label: "Work",
      },
    });
  });

  it("maps remove to providers.setEnabled profileAction", () => {
    let captured: CapturedRemoveMutation | null = null;
    const getCaptured = (): CapturedRemoveMutation => {
      if (captured === null) throw new Error("Mutation was not captured.");
      return captured;
    };
    mocks.useHostMutation.mockImplementation((args: CapturedRemoveMutation) => {
      captured = args;
      return { mutate: vi.fn(), isPending: false, error: null };
    });

    renderHook(() => useRemoveProviderProfile(), { wrapper });

    expect(
      getCaptured().mapVariables({
        providerId: "codex",
        profileId: "profile-1",
      }),
    ).toEqual({
      providerId: "codex",
      enabled: true,
      native: null,
      profileAction: {
        type: "remove",
        profileId: "profile-1",
      },
    });
  });

  it("maps recolor to providers.setEnabled profileAction", () => {
    let captured: CapturedRecolorMutation | null = null;
    const getCaptured = (): CapturedRecolorMutation => {
      if (captured === null) throw new Error("Mutation was not captured.");
      return captured;
    };
    mocks.useHostMutation.mockImplementation(
      (args: CapturedRecolorMutation) => {
        captured = args;
        return { mutate: vi.fn(), isPending: false, error: null };
      },
    );

    renderHook(() => useRecolorProviderProfile(), { wrapper });

    expect(
      getCaptured().mapVariables({
        providerId: "codex",
        profileId: "profile-1",
        accentColor: "#14b8a6",
      }),
    ).toEqual({
      providerId: "codex",
      enabled: true,
      native: null,
      profileAction: {
        type: "recolor",
        profileId: "profile-1",
        accentColor: "#14b8a6",
      },
    });
  });

  it("maps acknowledgeAmbientDrift to providers.setEnabled profileAction, with no profileId", () => {
    let captured: CapturedAcknowledgeAmbientDriftMutation | null = null;
    const getCaptured = (): CapturedAcknowledgeAmbientDriftMutation => {
      if (captured === null) throw new Error("Mutation was not captured.");
      return captured;
    };
    mocks.useHostMutation.mockImplementation(
      (args: CapturedAcknowledgeAmbientDriftMutation) => {
        captured = args;
        return { mutate: vi.fn(), isPending: false, error: null };
      },
    );

    renderHook(() => useAcknowledgeAmbientDrift(), { wrapper });

    expect(getCaptured().mapVariables({ providerId: "codex" })).toEqual({
      providerId: "codex",
      enabled: true,
      native: null,
      profileAction: { type: "acknowledgeAmbientDrift" },
    });
  });
});
