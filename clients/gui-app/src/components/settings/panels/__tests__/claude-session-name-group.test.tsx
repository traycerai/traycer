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
const toasted = vi.hoisted(() => vi.fn());

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (...args: ReadonlyArray<unknown>) => {
    toasted(...args);
  },
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
  /** Answers the held second `config.sessionNames.set`. */
  readonly releaseSecondSet: () => void;
  /** Answers the held read that followed the first write. */
  readonly releaseHeldRead: () => void;
  readonly queryClient: QueryClient;
}

/** How the mock host answers. */
interface HostBehaviour {
  /**
   * Keeps the first write unanswered until `releaseFirstSet`, while later
   * writes answer at once: a test can act while a save is in flight, and a
   * later save that is not queued behind it lands first.
   */
  readonly holdFirstSet: boolean;
  /** Refuses the first write; later writes succeed. */
  readonly failFirstSet: boolean;
  /** Keeps the second write unanswered until `releaseSecondSet`. */
  readonly holdSecondSet: boolean;
  /** Refuses the second write. */
  readonly failSecondSet: boolean;
  /**
   * Keeps the first read after the first write unanswered until
   * `releaseHeldRead`, then answers what the host held when it was asked.
   */
  readonly holdReadAfterFirstSet: boolean;
  readonly failReads: boolean;
}

const ANSWERS_EVERYTHING: HostBehaviour = {
  holdFirstSet: false,
  failFirstSet: false,
  holdSecondSet: false,
  failSecondSet: false,
  holdReadAfterFirstSet: false,
  failReads: false,
};

function held(hold: boolean): {
  readonly settled: Promise<void>;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const settled = hold
    ? new Promise<void>((settle) => {
        release = settle;
      })
    : Promise.resolve();
  return { settled, release: () => release() };
}

function mountHarness(
  initialTemplate: string,
  behaviour: HostBehaviour,
): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let stored = initialTemplate;
  const sets: ConfigSessionNamesSetRequest[] = [];
  const firstSet = held(behaviour.holdFirstSet);
  const secondSet = held(behaviour.holdSecondSet);
  const readAfterFirstSet = held(behaviour.holdReadAfterFirstSet);
  let readHeld = false;
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
        "config.sessionNames.get": async () => {
          if (behaviour.failReads) throw new Error("config.json is garbage");
          const answer = read();
          if (sets.length > 0 && !readHeld) {
            readHeld = true;
            await readAfterFirstSet.settled;
          }
          return answer;
        },
        "config.sessionNames.set": async (params) => {
          sets.push(params);
          const index = sets.length;
          if (index === 1) await firstSet.settled;
          if (index === 2) await secondSet.settled;
          if (
            (index === 1 && behaviour.failFirstSet) ||
            (index === 2 && behaviour.failSecondSet)
          ) {
            throw new Error("config.json could not be written");
          }
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
    releaseFirstSet: firstSet.release,
    releaseSecondSet: secondSet.release,
    releaseHeldRead: readAfterFirstSet.release,
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
  behaviour: HostBehaviour,
): Promise<Harness> {
  const harness = mountHarness(initialTemplate, behaviour);
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

function resetButton(): HTMLButtonElement {
  const button = screen.getByTestId("claude-session-name-reset");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Reset is not a button");
  }
  return button;
}

beforeEach(() => {
  state.reachability = { status: "reachable", hostLabel: "Host A" };
  state.supportedGet = true;
  state.supportedSet = true;
  state.client = null;
  tracked.mockClear();
  toasted.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClaudeSessionNameGroup", () => {
  it("renders nothing when the host does not advertise config.sessionNames.set", () => {
    state.supportedSet = false;
    const { queryClient } = mountHarness("{project}-x", ANSWERS_EVERYTHING);
    const { container } = renderGroup(queryClient);

    expect(container.childElementCount).toBe(0);
  });

  it("shows the stored template and a preview rendered against the sample project", async () => {
    await renderReady("{project}-x", ANSWERS_EVERYTHING);

    expect(templateInput().value).toBe("{project}-x");
    expect(
      screen.getByTestId("claude-session-name-preview").textContent,
    ).toContain("my-app-x");
  });

  it("sends exactly one set with the edited template when the field is blurred", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);

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

  it("flags a placeholder with digits as unknown", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);

    fireEvent.change(templateInput(), { target: { value: "{project1}" } });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "{project1}",
    );
    fireEvent.blur(templateInput());
    expect(harness.sets).toEqual([]);
  });

  it("flags an unknown placeholder and does not send it on blur", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);

    fireEvent.change(templateInput(), { target: { value: "{nope}" } });

    expect((await screen.findByRole("alert")).textContent).toContain("{nope}");
    fireEvent.blur(templateInput());
    // The blur handler records a save and sends it in one synchronous step,
    // so an unrecorded save is a write that was never sent.
    expect(tracked).not.toHaveBeenCalled();
    expect(harness.sets).toEqual([]);
  });

  it("discards an unsaved draft on Reset instead of saving it on the way out", async () => {
    const harness = await renderReady(DEFAULT_TEMPLATE, ANSWERS_EVERYTHING);

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

  it("keeps the field and Reset disabled while a save is in flight", async () => {
    const harness = await renderReady("{project}-x", {
      ...ANSWERS_EVERYTHING,
      holdFirstSet: true,
    });

    fireEvent.change(templateInput(), { target: { value: "{project}-y" } });
    fireEvent.blur(templateInput());

    await waitFor(() => {
      expect(templateInput().disabled).toBe(true);
    });
    expect(resetButton().disabled).toBe(true);
    harness.releaseFirstSet();

    await waitFor(() => {
      expect(templateInput().disabled).toBe(false);
    });
    expect(templateInput().value).toBe("{project}-y");
    expect(harness.sets).toEqual([{ claudeTemplate: "{project}-y" }]);
  });

  it("keeps a later pending save's draft when an earlier save is read back, and retries it after a refusal", async () => {
    const harness = await renderReady("{project}-x", {
      ...ANSWERS_EVERYTHING,
      holdReadAfterFirstSet: true,
      holdSecondSet: true,
      failSecondSet: true,
    });

    // Save B lands; its read-back is held.
    fireEvent.change(templateInput(), { target: { value: "{project}-y" } });
    fireEvent.blur(templateInput());
    await waitFor(() => {
      expect(templateInput().disabled).toBe(false);
    });
    // Save C is sent before B's read-back answers.
    fireEvent.change(templateInput(), { target: { value: "{project}-z" } });
    fireEvent.blur(templateInput());
    await waitFor(() => {
      expect(harness.sets).toHaveLength(2);
    });
    harness.releaseHeldRead();
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });
    // B's read-back does not replace the draft C is saving.
    expect(templateInput().value).toBe("{project}-z");

    harness.releaseSecondSet();
    await waitFor(() => {
      expect(toasted).toHaveBeenCalledTimes(1);
    });
    expect(templateInput().value).toBe("{project}-z");
    await waitFor(() => {
      fireEvent.blur(templateInput());
      expect(harness.sets).toHaveLength(3);
    });
    expect(harness.sets[2]).toEqual({ claudeTemplate: "{project}-z" });
  });

  it("keeps a refused save's draft when an earlier save's read-back lands after the refusal", async () => {
    const harness = await renderReady("{project}-x", {
      ...ANSWERS_EVERYTHING,
      holdReadAfterFirstSet: true,
      holdSecondSet: true,
      failSecondSet: true,
    });

    // Save B lands; its read-back is held.
    fireEvent.change(templateInput(), { target: { value: "{project}-y" } });
    fireEvent.blur(templateInput());
    await waitFor(() => {
      expect(templateInput().disabled).toBe(false);
    });
    // Save C is refused before B's read-back answers.
    fireEvent.change(templateInput(), { target: { value: "{project}-z" } });
    fireEvent.blur(templateInput());
    await waitFor(() => {
      expect(harness.sets).toHaveLength(2);
    });
    harness.releaseSecondSet();
    await waitFor(() => {
      expect(toasted).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(templateInput().disabled).toBe(false);
    });
    harness.releaseHeldRead();
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });

    // The refused draft stays for a retry, and the retry sends it.
    expect(templateInput().value).toBe("{project}-z");
    await waitFor(() => {
      fireEvent.blur(templateInput());
      expect(harness.sets).toHaveLength(3);
    });
    expect(harness.sets[2]).toEqual({ claudeTemplate: "{project}-z" });
  });

  it("lets a keyboard user reach Reset without saving the draft, and saves it when focus leaves Reset elsewhere", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);
    const reset = screen.getByTestId("claude-session-name-reset");

    fireEvent.change(templateInput(), { target: { value: "{project}-y" } });
    fireEvent.blur(templateInput(), { relatedTarget: reset });
    // A save is recorded and sent in one synchronous step.
    expect(tracked).not.toHaveBeenCalled();
    fireEvent.blur(reset, { relatedTarget: null });
    await waitFor(() => {
      expect(harness.sets).toEqual([{ claudeTemplate: "{project}-y" }]);
    });
    await waitFor(() => {
      expect(templateInput().disabled).toBe(false);
    });

    fireEvent.change(templateInput(), { target: { value: "{project}-q" } });
    fireEvent.blur(templateInput(), { relatedTarget: reset });
    fireEvent.click(reset);
    await waitFor(() => {
      expect(harness.sets).toEqual([
        { claudeTemplate: "{project}-y" },
        { claudeTemplate: DEFAULT_TEMPLATE },
      ]);
    });
    expect(templateInput().value).toBe(DEFAULT_TEMPLATE);
  });

  it("retries a save that failed when the same draft is committed again", async () => {
    const harness = await renderReady("{project}-x", {
      ...ANSWERS_EVERYTHING,
      failFirstSet: true,
    });

    fireEvent.change(templateInput(), { target: { value: "{project}-y" } });
    fireEvent.blur(templateInput());
    await waitFor(() => {
      expect(harness.sets).toHaveLength(1);
    });
    // The refused write is reported, and leaves the host on the old template.
    await waitFor(() => {
      expect(toasted).toHaveBeenCalledTimes(1);
    });
    expect(harness.stored()).toBe("{project}-x");

    // The user commits the same draft again (focus out of the field), as
    // often as it takes: a field that counts the refused write as sent never
    // sends it again.
    await waitFor(() => {
      fireEvent.blur(templateInput());
      expect(harness.sets).toHaveLength(2);
    });
    expect(harness.sets).toEqual([
      { claudeTemplate: "{project}-y" },
      { claudeTemplate: "{project}-y" },
    ]);
    await waitFor(() => {
      expect(harness.stored()).toBe("{project}-y");
    });
  });

  it("saves the default typed by hand when focus leaves to nothing focusable", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);

    // Typing the default exactly removes Reset, so no Reset button is there
    // for focus to move to; a blur onto nothing focusable still saves.
    fireEvent.change(templateInput(), { target: { value: DEFAULT_TEMPLATE } });
    expect(screen.queryByTestId("claude-session-name-reset")).toBeNull();
    fireEvent.blur(templateInput(), { relatedTarget: null });

    await waitFor(() => {
      expect(harness.stored()).toBe(DEFAULT_TEMPLATE);
    });
    expect(harness.sets).toEqual([{ claudeTemplate: DEFAULT_TEMPLATE }]);
  });

  it("refuses a template over 200 characters inline instead of sending it", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);

    fireEvent.change(templateInput(), { target: { value: "x".repeat(201) } });
    fireEvent.blur(templateInput());

    expect((await screen.findByRole("alert")).textContent).toContain("200");
    expect(tracked).not.toHaveBeenCalled();
    expect(harness.sets).toEqual([]);
  });

  it("stops showing progress once the read has failed", async () => {
    const { queryClient } = mountHarness("{project}-x", {
      ...ANSWERS_EVERYTHING,
      failReads: true,
    });
    renderGroup(queryClient);

    await screen.findByRole("alert");
    const group = screen.getByTestId("claude-session-name-group");
    // The spinner is the row's only decorative (aria-hidden) element.
    expect(group.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("resets a customised template by sending the default", async () => {
    const harness = await renderReady("{project}-x", ANSWERS_EVERYTHING);

    fireEvent.click(screen.getByTestId("claude-session-name-reset"));

    await waitFor(() => {
      expect(harness.sets).toEqual([{ claudeTemplate: DEFAULT_TEMPLATE }]);
    });
  });
});
