import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ConfigSessionNamesResponse,
  ConfigSessionNamesSetRequest,
} from "@traycer/protocol/host/config/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The Claude session name field: its gate (absent, not inert), what it shows
 * for the stored template, and the one write it makes. RPCs run for real
 * against a `MockHostMessenger`, so the read, the write and the re-read go
 * through the actual query/mutation path. Only the per-host FACTS the field
 * cannot synthesize - reachability, whether the host advertised each method,
 * and the ambient client - are mocked.
 */
const state = vi.hoisted(
  (): {
    reachability: { status: string; hostLabel: string };
    supportedGet: boolean | null;
    supportedSet: boolean | null;
    client: HostClient<HostRpcRegistry> | null;
  } => ({
    reachability: { status: "reachable", hostLabel: "Host A" },
    supportedGet: true,
    supportedSet: true,
    client: null,
  }),
);
const tracked = vi.hoisted(() => vi.fn());

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: () => undefined,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => state.reachability,
}));

// The two methods negotiate independently, so the mock answers per method.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "config.sessionNames.set"
      ? state.supportedSet
      : state.supportedGet,
  useHostSupportsMethod: () => state.supportedGet === true,
  useHostMethodSchemaVersion: () => null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => state.client,
}));

vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  trackSettingChanged: (...args: ReadonlyArray<unknown>) => {
    tracked(...args);
  },
}));

import { ClaudeSessionNameGroup } from "@/components/settings/panels/claude-session-name-group";

const HOST_ID = "host-a";
const DEFAULT_TEMPLATE = "Traycer · {project} · {date}";
const PLACEHOLDERS = [
  "project",
  "repository",
  "branch",
  "task",
  "agent",
  "agent_id",
  "date",
  "time",
];

interface Harness {
  /** Every `config.sessionNames.set` request body, in order. */
  readonly sets: ReadonlyArray<ConfigSessionNamesSetRequest>;
  /** The template the host holds now. */
  readonly stored: () => string;
  /** Answers the held first `config.sessionNames.set`. */
  readonly releaseFirstSet: () => void;
  readonly queryClient: QueryClient;
}

/**
 * `holdFirstSet` keeps the first write unanswered until `releaseFirstSet`, while
 * later writes answer at once: a test can act while a save is in flight, and a
 * later save that is not queued behind it lands first.
 */
function mountHarness(
  initialTemplate: string,
  holdFirstSet: boolean,
  failReads: boolean,
): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let stored = initialTemplate;
  const sets: ConfigSessionNamesSetRequest[] = [];
  let release: () => void = () => undefined;
  const firstHeld = holdFirstSet
    ? new Promise<void>((settle) => {
        release = settle;
      })
    : Promise.resolve();
  const read = (): ConfigSessionNamesResponse => ({
    claudeTemplate: stored,
    defaultClaudeTemplate: DEFAULT_TEMPLATE,
    placeholders: PLACEHOLDERS,
  });
  const messenger: MockHostMessenger<HostRpcRegistry> =
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${Math.random().toString(36).slice(2)}`,
      handlers: {
        "config.sessionNames.get": () =>
          failReads
            ? Promise.reject(new Error("config.json is garbage"))
            : Promise.resolve(read()),
        "config.sessionNames.set": async (params) => {
          sets.push(params);
          if (sets.length === 1) await firstHeld;
          stored = params.claudeTemplate;
          return read();
        },
      },
    });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  state.client = spine.createRequester(mockLocalHostEntry);
  return {
    sets,
    stored: () => stored,
    releaseFirstSet: () => {
      release();
    },
    queryClient,
  };
}

function renderGroup(queryClient: QueryClient): RenderResult {
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    <ClaudeSessionNameGroup providerId="claude-code" hostId={HOST_ID} />,
    { wrapper: Wrapper },
  );
}

/** Mounts against a stored template and waits for the field to load. */
async function renderReady(
  initialTemplate: string,
  holdFirstSet: boolean,
): Promise<Harness> {
  const harness = mountHarness(initialTemplate, holdFirstSet, false);
  renderGroup(harness.queryClient);
  await screen.findByTestId("claude-session-name-input");
  return harness;
}

function templateInput(): HTMLInputElement {
  const input = screen.getByTestId("claude-session-name-input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("the session name template is not an input");
  }
  return input;
}

beforeEach(() => {
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.supportedGet = true;
  state.supportedSet = true;
  state.client = null;
  tracked.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClaudeSessionNameGroup", () => {
  it("renders nothing when the host does not advertise config.sessionNames.set", () => {
    state.supportedSet = false;
    const { queryClient } = mountHarness("{project}-x", false, false);
    const { container } = renderGroup(queryClient);

    expect(container.childElementCount).toBe(0);
  });

  it("shows the stored template and a preview rendered against the sample project", async () => {
    await renderReady("{project}-x", false);

    expect(templateInput().value).toBe("{project}-x");
    expect(
      screen.getByTestId("claude-session-name-preview").textContent,
    ).toContain("my-app-x");
  });

  it("sends exactly one set with the edited template when the field is blurred", async () => {
    const harness = await renderReady("{project}-x", false);

    fireEvent.change(templateInput(), {
      target: { value: "{project}-{branch}" },
    });
    fireEvent.blur(templateInput());

    await waitFor(() => {
      expect(harness.sets).toEqual([{ claudeTemplate: "{project}-{branch}" }]);
    });
    expect(tracked).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith("providers", "claudeSessionName");
  });

  it("flags an unknown placeholder and does not send it on blur", async () => {
    const harness = await renderReady("{project}-x", false);

    fireEvent.change(templateInput(), { target: { value: "{nope}" } });

    expect((await screen.findByRole("alert")).textContent).toContain("{nope}");
    fireEvent.blur(templateInput());
    // The blur handler records a save and sends it in one synchronous step,
    // so an unrecorded save is a write that was never sent.
    expect(tracked).not.toHaveBeenCalled();
    expect(harness.sets).toEqual([]);
  });

  it("discards an unsaved draft on Reset instead of saving it on the way out", async () => {
    const harness = await renderReady(DEFAULT_TEMPLATE, false);

    fireEvent.change(templateInput(), { target: { value: "{project}-x" } });
    const reset = screen.getByTestId("claude-session-name-reset");
    // A browser moves focus off the field on a mousedown nobody prevented,
    // which blurs it before the click lands.
    if (fireEvent.mouseDown(reset)) fireEvent.blur(templateInput());
    fireEvent.click(reset);

    await waitFor(() => {
      expect(templateInput().value).toBe(DEFAULT_TEMPLATE);
    });
    expect(harness.stored()).toBe(DEFAULT_TEMPLATE);
    expect(harness.sets).toEqual([]);
  });

  it("saves an edit back to the old template while the first save is in flight", async () => {
    const harness = await renderReady("{project}-x", true);

    fireEvent.change(templateInput(), { target: { value: "{project}-y" } });
    fireEvent.blur(templateInput());
    fireEvent.change(templateInput(), { target: { value: "{project}-x" } });
    fireEvent.blur(templateInput());
    harness.releaseFirstSet();

    // The edit back is sent, and only after the first save: the host ends on
    // the user's last choice.
    await waitFor(() => {
      expect(harness.sets).toEqual([
        { claudeTemplate: "{project}-y" },
        { claudeTemplate: "{project}-x" },
      ]);
    });
    await waitFor(() => {
      expect(templateInput().value).toBe("{project}-x");
    });
    expect(harness.stored()).toBe("{project}-x");
  });

  it("refuses a template over 200 characters inline instead of sending it", async () => {
    const harness = await renderReady("{project}-x", false);

    fireEvent.change(templateInput(), { target: { value: "x".repeat(201) } });
    fireEvent.blur(templateInput());

    expect((await screen.findByRole("alert")).textContent).toContain("200");
    expect(tracked).not.toHaveBeenCalled();
    expect(harness.sets).toEqual([]);
  });

  it("stops showing progress once the read has failed", async () => {
    const { queryClient } = mountHarness("{project}-x", false, true);
    renderGroup(queryClient);

    await screen.findByRole("alert");
    const group = screen.getByTestId("claude-session-name-group");
    // The spinner is the row's only decorative (aria-hidden) element.
    expect(group.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("resets a customised template by sending the default", async () => {
    const harness = await renderReady("{project}-x", false);

    fireEvent.click(screen.getByTestId("claude-session-name-reset"));

    await waitFor(() => {
      expect(harness.sets).toEqual([{ claudeTemplate: DEFAULT_TEMPLATE }]);
    });
  });
});
