// The Personal pages read through the window's own host. Mocked at the scope
// boundary, as the other settings panel suites do, because they render bare,
// without the host runtime the real scope composes.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return { useHostScope, usePersonalHostScope: useHostScope };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentStatusResponseV11,
  LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { usePersonalRowNotes } from "@/components/settings/personal/personal-page-context";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { UPDATE_HOST_TEXT } from "@/components/settings/personal/personal-page-status";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import type { SettingsSectionId } from "@/lib/settings-sections";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST_ID = "host-a";
const HOST_NAME = "dev-box";
const STATUS_METHODS = ["environment.status", "environment.localOverrides"];

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
});

function variableOverride(key: string): LocalOverride {
  return {
    target: { kind: "variable", key },
    os: "any",
    value: "local-value",
    setAt: 1,
  };
}

function envOverrideOverride(key: string): LocalOverride {
  return {
    target: { kind: "env_override", providerId: "claude-code", key },
    os: "any",
    value: "local-value",
    setAt: 1,
  };
}

interface HostCalls {
  status: number;
}

/** Shows what `usePersonalRowNotes("variable")` answers, one row per key. */
function RowNotesProbe(): ReactNode {
  const notes = usePersonalRowNotes("variable");
  return (
    <ul data-testid="row-notes">
      {[...notes.entries()].map(([key, note]) => (
        <li key={key}>{`${key}: ${note}`}</li>
      ))}
    </ul>
  );
}

function FakePanel(): ReactNode {
  return (
    <SettingsPanelShell title="Shell" description="How terminals start.">
      <button type="button">Edit the page</button>
      <RowNotesProbe />
    </SettingsPanelShell>
  );
}

function renderFrame(options: {
  readonly section: SettingsSectionId;
  /** `null` records nothing: no handshake has completed yet. */
  readonly methods: readonly string[] | null;
  readonly status: EnvironmentStatusResponseV11;
  readonly overrides: readonly LocalOverride[];
}): HostCalls {
  const calls: HostCalls = { status: 0 };
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.status": () => {
      calls.status += 1;
      return options.status;
    },
    "environment.localOverrides": () => ({ overrides: [...options.overrides] }),
  };
  const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
  if (options.methods !== null) {
    recordNegotiatedHostMethods(HOST_ID, options.methods);
  }
  scopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId: HOST_ID, name: HOST_NAME }),
    hostId: HOST_ID,
    status: "ready",
    client,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PersonalPageFrame section={options.section}>
        <FakePanel />
      </PersonalPageFrame>
    </QueryClientProvider>,
  );
  return calls;
}

describe("<PersonalPageFrame /> on a host that does not advertise environment.status", () => {
  it("puts the page inside an inert region and the update line outside it", async () => {
    renderFrame({
      section: "shell",
      methods: ["host.status"],
      status: environmentStatusFixture({}),
      overrides: [],
    });
    const line = await screen.findByTestId("personal-page-status");
    expect(line.textContent).toBe(UPDATE_HOST_TEXT);
    // Outside the inert region, so assistive technology still reads it.
    expect(line.closest("[inert]")).toBeNull();
    // The page body is inside it: no edits until the host is updated.
    const edit = screen.getByRole("button", { name: "Edit the page" });
    expect(edit.closest("[inert]")).not.toBeNull();
    // The shell skips its own copy of the line in this state.
    expect(screen.getAllByTestId("personal-page-status")).toHaveLength(1);
  });
});

describe("<PersonalPageFrame /> on a host with a ready status", () => {
  it("draws the status line inside the panel shell's header, and the page is not inert", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        items: [itemStatusFixture({ kind: "variable", key: "LOG_LEVEL" })],
      }),
      overrides: [],
    });
    const line = await screen.findByTestId("personal-page-status");
    expect(line.textContent).toBe("Applied on dev-box.");
    const header = line.closest("header");
    if (header === null) throw new Error("the line is not inside a header");
    expect(header.closest("[data-settings-panel-shell]")).not.toBeNull();
    expect(within(header).getByRole("heading", { name: "Shell" })).toBeTruthy();
    expect(line.closest("[inert]")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit the page" }).closest("[inert]"),
    ).toBeNull();
  });

  it("says a failed item did not apply, naming the host", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        items: [
          itemStatusFixture({
            kind: "variable",
            key: "LOG_LEVEL",
            status: "failed",
            code: "permission_denied",
          }),
        ],
      }),
      overrides: [],
    });
    const line = await screen.findByTestId("personal-page-status");
    expect(line.textContent).toBe(
      "LOG_LEVEL didn't apply on dev-box: permission denied.",
    );
  });

  it("says changes wait for a reconnect while the host cannot reach the environment", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({ reachability: "reconnecting" }),
      overrides: [],
    });
    const line = await screen.findByTestId("personal-page-status");
    expect(line.textContent).toBe(
      "Changes apply on dev-box when it reconnects.",
    );
  });

  it("shows no line when the host has no settings of the person's yet, and leaves the page as it was", async () => {
    const calls = renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({ principal: null }),
      overrides: [],
    });
    await vi.waitFor(() => {
      expect(calls.status).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("personal-page-status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit the page" }).closest("[inert]"),
    ).toBeNull();
  });

  it("claims nothing before the host has handshaked", () => {
    const calls = renderFrame({
      section: "shell",
      methods: null,
      status: environmentStatusFixture({}),
      overrides: [],
    });
    expect(screen.queryByTestId("personal-page-status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit the page" }).closest("[inert]"),
    ).toBeNull();
    expect(calls.status).toBe(0);
  });
});

describe("<PersonalPageFrame /> around a page that is not a Personal page", () => {
  it("renders its children untouched and never asks the host for a status", async () => {
    const calls = renderFrame({
      section: "general",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        items: [itemStatusFixture({ kind: "variable", key: "LOG_LEVEL" })],
      }),
      overrides: [variableOverride("LOG_LEVEL")],
    });
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Edit the page" }),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("personal-page-status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit the page" }).closest("[inert]"),
    ).toBeNull();
    expect(calls.status).toBe(0);
    // No Personal context: rows get no notes.
    expect(
      within(screen.getByTestId("row-notes")).queryAllByRole("listitem"),
    ).toEqual([]);
  });
});

// `environment.localOverrides` and `pendingUploads` come from the fake host
// above, which drives these rows.
describe("usePersonalRowNotes (localOverrides and pendingUploads from the fake host)", () => {
  function notes(): string[] {
    return within(screen.getByTestId("row-notes"))
      .queryAllByRole("listitem")
      .map((item) => item.textContent)
      .sort();
  }

  it("notes a local override on the host that holds it", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        items: [itemStatusFixture({ kind: "variable", key: "LOG_LEVEL" })],
      }),
      overrides: [variableOverride("LOG_LEVEL")],
    });
    await vi.waitFor(() => {
      expect(notes()).toEqual(["LOG_LEVEL: Overridden on dev-box"]);
    });
  });

  it("ignores an override of another target kind", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        items: [itemStatusFixture({ kind: "variable", key: "LOG_LEVEL" })],
      }),
      // The variable's note appearing proves the overrides were read; the
      // env override beside it must not produce a row note of its own.
      overrides: [
        envOverrideOverride("ANTHROPIC_BASE_URL"),
        variableOverride("LOG_LEVEL"),
      ],
    });
    await vi.waitFor(() => {
      expect(notes()).toEqual(["LOG_LEVEL: Overridden on dev-box"]);
    });
  });

  it("notes an edit still waiting for its receipt as Pending", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        pendingUploads: [
          pendingUploadFixture({ kind: "variable", key: "WAITING" }),
          pendingUploadFixture({
            kind: "variable",
            key: "DONE",
            receipt: "accepted",
          }),
          pendingUploadFixture({
            kind: "env_override",
            key: "claude-code:OTHER_KIND",
          }),
        ],
      }),
      overrides: [],
    });
    await vi.waitFor(() => {
      expect(notes()).toEqual(["WAITING: Pending"]);
    });
  });

  it("lets Pending win over Overridden for the same key", async () => {
    renderFrame({
      section: "shell",
      methods: STATUS_METHODS,
      status: environmentStatusFixture({
        pendingUploads: [
          pendingUploadFixture({ kind: "variable", key: "LOG_LEVEL" }),
        ],
      }),
      overrides: [variableOverride("LOG_LEVEL"), variableOverride("OTHER")],
    });
    await vi.waitFor(() => {
      expect(notes()).toEqual([
        "LOG_LEVEL: Pending",
        "OTHER: Overridden on dev-box",
      ]);
    });
  });
});

/** Reads `config.env.list` the way the Shell panel's variables table does. */
function VariablesProbe(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  useHostQuery<HostRpcRegistry, "config.env.list">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "config.env.list",
    params: {},
    options: { enabled: true },
  });
  return null;
}

// A variable's value can change under a mounted page without the page writing
// it: the dashboard edits the shared value, and the host (which answers the
// shared value while it holds its own) reports a new revision of the person's
// settings. The variables read is one of the reads that revision re-reads.
describe("<PersonalPageFrame /> around a page that reads the variables", () => {
  it("requests config.env.list again when the host's received revision moves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const facts: { status: EnvironmentStatusResponseV11 } = {
        status: environmentStatusFixture({
          receivedRevision: 1,
          appliedRevision: 1,
        }),
      };
      const reads = { status: 0, variables: 0 };
      const handlers: MockHandlerMap<HostRpcRegistry> = {
        "environment.status": () => {
          reads.status += 1;
          return facts.status;
        },
        "environment.localOverrides": () => ({ overrides: [] }),
        "config.env.list": () => {
          reads.variables += 1;
          return { entries: [{ key: "LOG_LEVEL", value: "error" }] };
        },
      };
      const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
      recordNegotiatedHostMethods(HOST_ID, [
        ...STATUS_METHODS,
        "config.env.list",
      ]);
      scopeOverrides.current = {
        host: hostScopeOptionFixture({ hostId: HOST_ID, name: HOST_NAME }),
        hostId: HOST_ID,
        status: "ready",
        client,
      };
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <PersonalPageFrame section="shell">
            <VariablesProbe client={client} />
          </PersonalPageFrame>
        </QueryClientProvider>,
      );
      await vi.waitFor(() => {
        expect(reads.status).toBeGreaterThan(0);
        expect(reads.variables).toBeGreaterThan(0);
      });
      const statusReadsBefore = reads.status;
      const variableReadsBefore = reads.variables;

      // The dashboard changes the shared value: the host's received revision
      // moves from 1 to 2 (nothing else about the status does).
      facts.status = environmentStatusFixture({
        receivedRevision: 2,
        appliedRevision: 1,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });

      // The 5 s status poll fired again and saw the new revision.
      expect(reads.status).toBeGreaterThan(statusReadsBefore);
      await vi.waitFor(() => {
        expect(reads.variables).toBeGreaterThan(variableReadsBefore);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
