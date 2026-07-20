import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { MobileHostGate } from "@/components/layout/shell/mobile-host-gate";
import { useAuthStore } from "@/stores/auth/auth-store";

interface TestDirectory {
  getLocalEntry(): null;
  getCardinality(): "zero" | "one" | "many";
  onChange(listener: () => void): { dispose(): void };
  refresh(): Promise<readonly []>;
}

interface TestBinding {
  readonly directory: TestDirectory;
  readonly hostClient: {
    getActiveHostId(): string | null;
  };
}

const gateMocks = vi.hoisted(
  (): {
    binding: TestBinding | null;
    requestOpen: Mock<() => void>;
  } => ({
    binding: null,
    requestOpen: vi.fn(),
  }),
);

vi.mock("@/lib/host", () => ({
  useHostBinding: () => gateMocks.binding,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    hostPicker: { requestOpen: gateMocks.requestOpen },
  }),
}));

function signedIn(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "User One",
      email: "user@example.com",
    },
    { userId: "user-1", username: "user" },
    [],
  );
}

function makeDirectory(
  refresh: Mock<() => Promise<readonly []>>,
): TestDirectory {
  return {
    getLocalEntry: () => null,
    getCardinality: () => "one",
    onChange: () => ({ dispose: () => undefined }),
    refresh,
  };
}

function renderGate() {
  return render(
    <MobileHostGate bypass={false} noHost={<div data-testid="no-host" />}>
      <div data-testid="children" />
    </MobileHostGate>,
  );
}

describe("<MobileHostGate /> cardinality refresh guard", () => {
  beforeEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    gateMocks.binding = null;
    gateMocks.requestOpen.mockClear();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("skips the first signed-in render because startup already refreshed", () => {
    const refresh = vi.fn((): Promise<readonly []> => Promise.resolve([]));
    gateMocks.binding = {
      directory: makeDirectory(refresh),
      hostClient: { getActiveHostId: () => "host-1" },
    };
    signedIn();

    renderGate();

    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes on a later signed-in transition after an earlier false render", async () => {
    const refresh = vi.fn((): Promise<readonly []> => Promise.resolve([]));
    gateMocks.binding = {
      directory: makeDirectory(refresh),
      hostClient: { getActiveHostId: () => "host-1" },
    };
    const rendered = renderGate();

    expect(refresh).not.toHaveBeenCalled();

    act(() => {
      signedIn();
    });
    rendered.rerender(
      <MobileHostGate bypass={false} noHost={<div data-testid="no-host" />}>
        <div data-testid="children" />
      </MobileHostGate>,
    );

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});
