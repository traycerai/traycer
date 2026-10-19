// `useProvidersList` reads the app-wide host client. Mocked at that boundary
// (the way the provider panel suites do); the list itself is a real query over
// a fake host.
const clientMock = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientMock.current };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ProviderOnHostOnlyLine } from "@/components/settings/panels/provider-on-host-only-line";
import { PersonalPageContext } from "@/components/settings/personal/personal-page-context";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";

const HOST_ID = "host-a";
const LINE_TESTID = "profile-on-host-only";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
  useProviderLinkDialogStore.setState({ target: null });
});

interface OnHostOnlyEntry {
  readonly providerId: string;
  readonly profileId: string;
}

/**
 * Renders one line per `(providerId, profileId)` over a host whose
 * `providers.list` answers `onHostOnly` (omitted when `null`: a 10.0 host).
 * `providers.link` is advertised by the fake host's method list.
 */
function renderLines(options: {
  readonly onHostOnly: readonly OnHostOnlyEntry[] | null;
  readonly methods: readonly string[] | null;
  readonly lines: readonly OnHostOnlyEntry[];
  /** `null` renders outside any Personal page. */
  readonly hostName: string | null;
}): { readonly listCalls: () => number } {
  let listCalls = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        listCalls += 1;
        return options.onHostOnly === null
          ? { providers: [], native: null }
          : {
              providers: [],
              native: null,
              scope: "personal" as const,
              onHostOnly: [...options.onHostOnly],
            };
      },
    },
  });
  clientMock.current = client;
  if (options.methods !== null) {
    recordNegotiatedHostMethods(HOST_ID, options.methods);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const lines: ReactNode = options.lines.map((entry) => (
    <div
      key={`${entry.providerId}/${entry.profileId}`}
      data-testid={`${entry.providerId}/${entry.profileId}`}
    >
      <ProviderOnHostOnlyLine
        hostId={HOST_ID}
        providerId={entry.providerId}
        profileId={entry.profileId}
      />
    </div>
  ));
  render(
    <QueryClientProvider client={queryClient}>
      {options.hostName === null ? (
        lines
      ) : (
        <PersonalPageContext.Provider
          value={{
            state: { kind: "ready", status: environmentStatusFixture({}) },
            line: null,
            hostName: options.hostName,
            localOverrides: [],
            hostId: HOST_ID,
            client,
            notices: [],
            review: [],
          }}
        >
          {lines}
        </PersonalPageContext.Provider>
      )}
    </QueryClientProvider>,
  );
  return { listCalls: () => listCalls };
}

/** Lets an answered `providers.list` reach the page. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

function lineIn(entry: OnHostOnlyEntry): HTMLElement | null {
  const slot = screen.getByTestId(`${entry.providerId}/${entry.profileId}`);
  return slot.querySelector(`[data-testid="${LINE_TESTID}"]`);
}

const P1: OnHostOnlyEntry = { providerId: "claude-code", profileId: "p1" };
const P2: OnHostOnlyEntry = { providerId: "claude-code", profileId: "p2" };
const P1_OTHER_PROVIDER: OnHostOnlyEntry = {
  providerId: "codex",
  profileId: "p1",
};

describe("<ProviderOnHostOnlyLine />", () => {
  it("says the profile lives on this host only, for exactly the profile the list names", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list"],
      lines: [P1, P2, P1_OTHER_PROVIDER],
      hostName: "dev-box",
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toContain(
      "On dev-box only, link to use everywhere.",
    );
    // The line is in P1's slot; the same profile id under another provider and
    // a profile the list does not name get nothing.
    expect(lineIn(P1)).toBe(line);
    expect(lineIn(P2)).toBeNull();
    expect(lineIn(P1_OTHER_PROVIDER)).toBeNull();
  });

  it("offers Link on a host that advertises providers.link, and Link opens the dialog for that profile", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list", "providers.link"],
      lines: [P1],
      hostName: "dev-box",
    });
    const link = await screen.findByRole("button", { name: "Link" });
    expect(useProviderLinkDialogStore.getState().target).toBeNull();
    fireEvent.click(link);
    expect(useProviderLinkDialogStore.getState().target).toEqual({
      providerId: "claude-code",
      profileId: "p1",
    });
  });

  it("still says where the profile lives, with no Link button, on a host without providers.link", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list"],
      lines: [P1],
      hostName: "dev-box",
    });
    expect(await screen.findByTestId(LINE_TESTID)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  });

  it("offers no Link before the host has handshaked", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: null,
      lines: [P1],
      hostName: "dev-box",
    });
    expect(await screen.findByTestId(LINE_TESTID)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  });

  it("says nothing when the list names no profile as on this host only", async () => {
    const { listCalls } = renderLines({
      onHostOnly: [],
      methods: ["providers.list", "providers.link"],
      lines: [P1],
      hostName: "dev-box",
    });
    await vi.waitFor(() => {
      expect(listCalls()).toBeGreaterThan(0);
    });
    await settle();
    expect(lineIn(P1)).toBeNull();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  });

  it("says nothing on a host whose list carries no onHostOnly (a 10.0 host)", async () => {
    const { listCalls } = renderLines({
      onHostOnly: null,
      methods: ["providers.list", "providers.link"],
      lines: [P1],
      hostName: "dev-box",
    });
    await vi.waitFor(() => {
      expect(listCalls()).toBeGreaterThan(0);
    });
    await settle();
    expect(lineIn(P1)).toBeNull();
  });

  it("calls the host 'this host' outside a Personal page", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list"],
      lines: [P1],
      hostName: null,
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toContain(
      "On this host only, link to use everywhere.",
    );
  });

  it("renders a host label containing markup as literal text", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list"],
      lines: [P1],
      hostName: "<b>x</b>",
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toContain("On <b>x</b> only");
    expect(line.querySelector("b")).toBeNull();
  });
});
