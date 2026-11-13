import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import { ComposerMicPreparing } from "@/components/home/toolbar/composer-mic-button";
import { useDictationAvailability } from "@/hooks/composer/use-dictation-availability";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { SPEECH_MODEL_INSUFFICIENT_DISK_MESSAGE } from "@traycer/protocol/host/speech/schemas";

const host = vi.hoisted(() => ({
  ensureModel: vi.fn(),
  status: {
    engineAvailable: true,
    downloadState: "error",
    downloadProgress: null as number | null,
    errorMessage: null as string | null,
  },
}));

vi.mock("@/providers/use-runner-host", () => {
  const runnerHost = { deviceDictation: null };
  return {
    useRunnerHost: () => runnerHost,
    useRunnerHostOrNull: () => runnerHost,
  };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    hostClient: {
      createRequesterForHostId: (hostId: string | null) => ({
        getActiveHostId: () => hostId,
      }),
    },
  }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-requester-host-id", () => ({
  useRequesterHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly options: { readonly enabled: boolean };
  }) => ({
    data: args.options.enabled ? host.status : undefined,
  }),
  useHostMutation: () => ({ mutate: host.ensureModel, isPending: false }),
}));

function renderAvailability(message: string | null) {
  host.status.errorMessage = message;
  const client = new QueryClient();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <LazyMotion features={domAnimation}>{children}</LazyMotion>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(<AvailabilityMessage />, { wrapper });
  return view;
}

function AvailabilityMessage() {
  const availability = useDictationAvailability(true, "en-US");
  if (availability.preparing === null) return null;
  return <ComposerMicPreparing status={availability.preparing} />;
}

beforeEach(() => {
  host.status = {
    engineAvailable: true,
    downloadState: "error",
    downloadProgress: null,
    errorMessage: null,
  };
  host.ensureModel.mockClear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe("ComposerMicPreparing disk-space error copy", () => {
  it("shows the protocol's exact disk-space message from the real availability hook", () => {
    renderAvailability(SPEECH_MODEL_INSUFFICIENT_DISK_MESSAGE);

    expect(
      screen.getByRole("button", {
        name: SPEECH_MODEL_INSUFFICIENT_DISK_MESSAGE,
      }),
    ).not.toBeNull();
  });

  it("keeps every other host error on the generic retry label", () => {
    renderAvailability("network unavailable");

    expect(
      screen.getByRole("button", {
        name: "Voice dictation setup failed - retrying",
      }),
    ).not.toBeNull();
  });
});
