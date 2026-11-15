// `useProvidersList` reads the app-wide host client. Mocked at that boundary
// (the way the provider panel suites do); the list itself is a real query over
// a fake host.
const clientMock = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientMock.current };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ProviderOnHostOnlyLine } from "@/components/settings/panels/provider-on-host-only-line";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import { providersListQueryKey } from "@/lib/query-keys/providers-query-keys";

const HOST_ID = "host-a";
const LINE_TESTID = "profile-on-host-only";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
});

interface OnHostOnlyEntry {
  readonly providerId: string;
  readonly profileId: string;
}

/**
 * Renders one line per `(providerId, profileId)` over a host whose
 * `providers.list` answers `onHostOnly` (omitted when `null`: a 10.0 host).
 */
function renderLines(options: {
  readonly onHostOnly: readonly OnHostOnlyEntry[] | null;
  readonly methods: readonly string[] | null;
  readonly lines: readonly OnHostOnlyEntry[];
}): { readonly queryClient: QueryClient; readonly linkCalls: () => number } {
  let linkCalls = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        return options.onHostOnly === null
          ? { providers: [], native: null }
          : {
              providers: [],
              native: null,
              scope: "personal" as const,
              onHostOnly: [...options.onHostOnly],
            };
      },
      "providers.link": () => {
        linkCalls += 1;
        return {
          linkId: "link-1",
          prompt: {
            kind: "sign_in_url" as const,
            url: "https://example.invalid/sign-in",
            codePrompt: "Paste the code",
          },
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
  render(
    <QueryClientProvider client={queryClient}>
      {options.lines.map((entry) => (
        <div
          key={`${entry.providerId}/${entry.profileId}`}
          data-testid={`${entry.providerId}/${entry.profileId}`}
        >
          <ProviderOnHostOnlyLine
            providerId={entry.providerId}
            profileId={entry.profileId}
          />
        </div>
      ))}
    </QueryClientProvider>,
  );
  return {
    queryClient,
    linkCalls: () => linkCalls,
  };
}

async function waitForProvidersList(queryClient: QueryClient): Promise<void> {
  await vi.waitFor(() => {
    expect(
      queryClient.getQueryState(providersListQueryKey(HOST_ID))?.status,
    ).toBe("success");
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
  it("shows the available line for exactly the provider and profile the list names", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list"],
      lines: [P1, P2, P1_OTHER_PROVIDER],
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toBe("Available on this computer");
    // The line is in P1's slot; the same profile id under another provider and
    // a profile the list does not name get nothing.
    expect(lineIn(P1)).toBe(line);
    expect(lineIn(P2)).toBeNull();
    expect(lineIn(P1_OTHER_PROVIDER)).toBeNull();
  });

  it("shows the available line without a Link control when sign-ins are absent even if providers.link is advertised", async () => {
    const { linkCalls } = renderLines({
      onHostOnly: [P1],
      methods: ["providers.list", "providers.link"],
      lines: [P1],
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toBe("Available on this computer");
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    expect(linkCalls()).toBe(0);
  });

  it("shows the available line with no Link control on a host without providers.link", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: ["providers.list"],
      lines: [P1],
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toBe("Available on this computer");
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  });

  it("shows the available line without a Link control before the host has handshaked", async () => {
    renderLines({
      onHostOnly: [P1],
      methods: null,
      lines: [P1],
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toBe("Available on this computer");
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  });

  it("says nothing when the list names no profile as on this host only", async () => {
    const { queryClient } = renderLines({
      onHostOnly: [],
      methods: ["providers.list", "providers.link"],
      lines: [P1],
    });
    await waitForProvidersList(queryClient);
    expect(lineIn(P1)).toBeNull();
  });

  it("says nothing on a host whose list carries no onHostOnly (a 10.0 host)", async () => {
    const { queryClient } = renderLines({
      onHostOnly: null,
      methods: ["providers.list", "providers.link"],
      lines: [P1],
    });
    await waitForProvidersList(queryClient);
    expect(lineIn(P1)).toBeNull();
  });
});
