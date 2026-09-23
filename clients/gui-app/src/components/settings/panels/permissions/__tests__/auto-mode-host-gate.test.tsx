/**
 * `AutoModeHostGate` on its own: what it keeps mounted while the scope stops
 * serving, and what it refuses to keep. The body is a stateful child, so a
 * remount shows as lost state.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { AutoModeHostGate } from "@/components/settings/panels/permissions/auto-mode-host-gate";

type ScopeStatus = "following" | "ready" | "unreachable";
interface ScopeSnapshot {
  readonly status: ScopeStatus;
  readonly hostId: string;
}

const scopeStore = vi.hoisted(() => {
  let snapshot: ScopeSnapshot = { status: "following", hostId: "host-a" };
  const listeners = new Set<() => void>();
  return {
    get: (): ScopeSnapshot => snapshot,
    set: (next: ScopeSnapshot): void => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

// The handshake verdict for the gated method: `null` is "no handshake yet".
const supportStore = vi.hoisted(() => {
  let support: boolean | null = true;
  const listeners = new Set<() => void>();
  return {
    get: (): boolean | null => support,
    set: (next: boolean | null): void => {
      support = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

function useScope(): HostScope {
  const { status, hostId } = useSyncExternalStore(
    scopeStore.subscribe,
    scopeStore.get,
  );
  return hostScopeFixture({
    status,
    host: hostScopeOptionFixture({ hostId }),
  });
}
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => useScope(),
}));
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (): void => undefined,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () =>
    useSyncExternalStore(supportStore.subscribe, supportStore.get),
  useHostSupportsMethod: () => true,
}));

function Body(): ReactNode {
  const [text, setText] = useState("pristine");
  return (
    <div>
      <span data-testid="body-text">{text}</span>
      <button type="button" onClick={() => setText("EDITED")}>
        edit
      </button>
    </div>
  );
}

function Page(): ReactNode {
  return (
    <AutoModeHostGate method="autoPolicy.get" unsupported={<p>old</p>}>
      {() => <Body />}
    </AutoModeHostGate>
  );
}

async function moveScope(next: ScopeSnapshot): Promise<void> {
  await act(async () => {
    scopeStore.set(next);
    await Promise.resolve();
  });
}

async function moveSupport(next: boolean | null): Promise<void> {
  await act(async () => {
    supportStore.set(next);
    await Promise.resolve();
  });
}

beforeEach(() => {
  scopeStore.set({ status: "following", hostId: "host-a" });
  supportStore.set(true);
});
afterEach(cleanup);

describe("AutoModeHostGate", () => {
  it("renders its children under a serving scope", () => {
    render(<Page />);

    expect(screen.getByTestId("body-text").textContent).toBe("pristine");
  });

  it("renders nothing on another machine's binding when the scope stops serving on a different host", async () => {
    render(<Page />);
    expect(screen.getByTestId("body-text")).not.toBeNull();

    await moveScope({ status: "unreachable", hostId: "host-b" });

    expect(screen.queryByTestId("body-text")).toBeNull();
  });

  it("keeps the same mounted instance while the same host is briefly unreachable", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveScope({ status: "unreachable", hostId: "host-a" });
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveScope({ status: "following", hostId: "host-a" });
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");
  });

  it("keeps the same mounted instance through ready -> unreachable -> ready on the same host", async () => {
    await moveScope({ status: "ready", hostId: "host-a" });
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveScope({ status: "unreachable", hostId: "host-a" });
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveScope({ status: "ready", hostId: "host-a" });
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");
  });

  it("keeps the same mounted instance while a following host re-handshakes (true -> null -> true)", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveSupport(null);
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveSupport(true);
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");
  });

  it("remounts the body when the followed host moves from host-a to host-b", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    expect(screen.getByTestId("body-text").textContent).toBe("EDITED");

    await moveScope({ status: "following", hostId: "host-b" });
    expect(screen.getByTestId("body-text").textContent).toBe("pristine");
  });
});
