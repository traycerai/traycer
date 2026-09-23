/**
 * `HermesImportPanel`: the directory field and Scan action, the scanned rows
 * (soul/memories/skills/unreadable) with their default selection, the target
 * picker (new vs. existing identity), the summary sentence, and the run
 * result view (per-item outcomes, a refusal, and "Open identity").
 *
 * The identity mutation/query hooks are mocked so this suite drives fake
 * `mutateAsync` functions directly rather than a real host round trip - the
 * same shape `identity-skill-install.test.tsx` uses. `@/components/ui/select`
 * is stubbed with the flattened-listbox stand-in
 * `provider-model-provider-connect-dialog.test.tsx` uses, since Radix's real
 * Select needs pointer capabilities jsdom doesn't provide.
 */
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import type {
  AgentIdentityHermesRunRequest,
  AgentIdentityHermesRunResponse,
  AgentIdentityHermesScanRequest,
  AgentIdentityHermesScanResponse,
} from "@traycer/protocol/host/agent-identity/unary-schemas";
import { HermesImportPanel } from "@/components/session-import/hermes-import-panel";

const scanMock = vi.hoisted(() =>
  vi.fn<(request: AgentIdentityHermesScanRequest) => Promise<unknown>>(),
);
const runMock = vi.hoisted(() =>
  vi.fn<(request: AgentIdentityHermesRunRequest) => Promise<unknown>>(),
);
const scanPendingMock = vi.hoisted(() => ({ value: false }));
const runPendingMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/hooks/identities/use-identity-mutations", () => ({
  useIdentityHermesScanForClient: () => ({
    mutateAsync: scanMock,
    isPending: scanPendingMock.value,
  }),
  useIdentityHermesRunForClient: () => ({
    mutateAsync: runMock,
    isPending: runPendingMock.value,
  }),
}));

const identitiesListMock = vi.hoisted(() => ({
  data: undefined as
    | { readonly identities: readonly AgentIdentitySummary[] }
    | undefined,
  isError: false,
}));

vi.mock("@/hooks/identities/use-identity-queries", () => ({
  useIdentityListForClient: () => identitiesListMock,
}));

// Radix's Select needs a pointer-capable layout to open its listbox, which
// jsdom does not provide. The stand-in keeps the same element structure with
// every option always rendered and forwards `onValueChange`, the mock
// `provider-model-provider-connect-dialog.test.tsx` uses.
vi.mock("@/components/ui/select", () => {
  const ValueChangeContext = createContext<(value: string) => void>(
    () => undefined,
  );
  return {
    Select: (props: {
      readonly children: ReactNode;
      readonly value?: string;
      readonly onValueChange?: (value: string) => void;
    }) => (
      <ValueChangeContext.Provider
        value={props.onValueChange ?? (() => undefined)}
      >
        <div>{props.children}</div>
      </ValueChangeContext.Provider>
    ),
    SelectTrigger: (props: {
      readonly children: ReactNode;
      readonly "data-testid"?: string;
      readonly "aria-label"?: string;
    }) => (
      <button
        type="button"
        data-testid={props["data-testid"]}
        aria-label={props["aria-label"]}
      >
        {props.children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    SelectItem: (props: {
      readonly children: ReactNode;
      readonly value: string;
    }) => {
      const onValueChange = useContext(ValueChangeContext);
      return (
        <button
          type="button"
          data-value={props.value}
          onClick={() => onValueChange(props.value)}
        >
          {props.children}
        </button>
      );
    },
  };
});

afterEach(() => {
  cleanup();
  scanMock.mockReset();
  runMock.mockReset();
  scanPendingMock.value = false;
  runPendingMock.value = false;
  identitiesListMock.data = undefined;
  identitiesListMock.isError = false;
});

function renderPanel(
  onOpenIdentity: ((identity: AgentIdentitySummary) => void) | null,
) {
  const openIdentity = onOpenIdentity ?? vi.fn();
  const onClose = vi.fn();
  const view = render(
    <HermesImportPanel
      hostId="host-1"
      client={null}
      onOpenIdentity={openIdentity}
      onClose={onClose}
    />,
  );
  return { ...view, onOpenIdentity: openIdentity, onClose };
}

function scanRow(relPath: string): HTMLElement {
  const row = screen
    .getAllByTestId("hermes-import-row")
    .find((element) => element.getAttribute("data-rel-path") === relPath);
  if (row === undefined) {
    throw new Error(`no hermes-import-row for ${relPath}`);
  }
  return row;
}

const PROFILE_RESPONSE: AgentIdentityHermesScanResponse = {
  kind: "profile",
  profileName: "acme",
  items: [
    { kind: "soul", characters: 240 },
    { kind: "memory", relPath: "memories/MEMORY.md", entries: 3 },
    { kind: "memory", relPath: "memories/USER.md", entries: 1 },
    {
      kind: "skill",
      name: "Bundled Skill",
      relPath: "skills/bundled/SKILL.md",
      description: "Shipped with Hermes",
      bundled: true,
    },
    {
      kind: "skill",
      name: "User Skill",
      relPath: "skills/custom/SKILL.md",
      description: null,
      bundled: false,
    },
    {
      kind: "unreadable",
      relPath: "skills/broken/SKILL.md",
      reason: "source_unreadable",
      detail: "Permission denied",
    },
  ],
};

async function scanProfile(): Promise<void> {
  scanMock.mockResolvedValue(PROFILE_RESPONSE);
  fireEvent.change(screen.getByTestId("hermes-import-directory"), {
    target: { value: "~/.hermes/profiles/acme" },
  });
  fireEvent.click(screen.getByTestId("hermes-import-scan"));
  await screen.findByTestId("hermes-import-summary");
}

describe("<HermesImportPanel /> scan", () => {
  it("calls the scan mutation with the typed directory", async () => {
    scanMock.mockResolvedValue(PROFILE_RESPONSE);

    renderPanel(null);
    fireEvent.change(screen.getByTestId("hermes-import-directory"), {
      target: { value: "~/.hermes/profiles/acme" },
    });
    fireEvent.click(screen.getByTestId("hermes-import-scan"));

    await screen.findByTestId("hermes-import-summary");
    expect(scanMock).toHaveBeenCalledExactlyOnceWith({
      directory: "~/.hermes/profiles/acme",
    });
  });

  it("shows the not-a-profile notice with the response's detail", async () => {
    scanMock.mockResolvedValue({
      kind: "notAProfile",
      detail: "No SOUL.md in that folder.",
    });

    renderPanel(null);
    fireEvent.change(screen.getByTestId("hermes-import-directory"), {
      target: { value: "~/not-hermes" },
    });
    fireEvent.click(screen.getByTestId("hermes-import-scan"));

    const notice = await screen.findByTestId("hermes-import-not-a-profile");
    expect(notice.textContent).toContain("No SOUL.md in that folder.");
    expect(screen.queryByTestId("hermes-import-rows")).toBeNull();
  });
});

describe("<HermesImportPanel /> scanned rows and selection", () => {
  it("renders every row with its default selection and the bundled marker", async () => {
    renderPanel(null);
    await scanProfile();

    const soul = scanRow("SOUL.md");
    expect(soul.getAttribute("aria-checked")).toBe("true");

    const memoryMain = scanRow("memories/MEMORY.md");
    expect(memoryMain.getAttribute("aria-checked")).toBe("true");
    const memoryUser = scanRow("memories/USER.md");
    expect(memoryUser.getAttribute("aria-checked")).toBe("true");

    const bundled = scanRow("skills/bundled/SKILL.md");
    expect(bundled.getAttribute("data-bundled")).toBe("true");
    expect(bundled.getAttribute("aria-checked")).toBe("false");

    const userSkill = scanRow("skills/custom/SKILL.md");
    expect(userSkill.getAttribute("data-bundled")).toBe("false");
    expect(userSkill.getAttribute("aria-checked")).toBe("true");

    const unreadable = scanRow("skills/broken/SKILL.md");
    expect(unreadable.getAttribute("data-unreadable")).toBe("true");
  });

  it("defaults the new-identity title to Hermes (<profileName>)", async () => {
    renderPanel(null);
    await scanProfile();

    const title = screen.getByTestId("hermes-import-title") as HTMLInputElement;
    expect(title.value).toBe("Hermes (acme)");
  });

  it("shows the selection summary naming a new identity, and updates it when a row is toggled", async () => {
    renderPanel(null);
    await scanProfile();

    const summary = screen.getByTestId("hermes-import-summary");
    expect(summary.textContent).toBe(
      "Import the soul, 2 memory files and 1 skill into a new identity “Hermes (acme)”.",
    );

    fireEvent.click(scanRow("skills/bundled/SKILL.md"));

    expect(screen.getByTestId("hermes-import-summary").textContent).toBe(
      "Import the soul, 2 memory files and 2 skills (1 bundled) into a new identity “Hermes (acme)”.",
    );
  });

  it("toggling every row off shows the nothing-selected summary and disables Import", async () => {
    renderPanel(null);
    await scanProfile();

    fireEvent.click(scanRow("SOUL.md"));
    fireEvent.click(scanRow("memories/MEMORY.md"));
    fireEvent.click(scanRow("memories/USER.md"));
    fireEvent.click(scanRow("skills/custom/SKILL.md"));

    expect(screen.getByTestId("hermes-import-summary").textContent).toBe(
      "Nothing selected to import.",
    );
    expect(screen.getByTestId("hermes-import-run")).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("<HermesImportPanel /> run", () => {
  it("calls the run mutation with the request built from the default selection and the new title", async () => {
    runMock.mockResolvedValue({
      kind: "imported",
      identity: {
        identityId: "identity-1",
        title: "Hermes (acme)",
        description: null,
        updatedAt: 0,
      },
      items: [],
    });

    renderPanel(null);
    await scanProfile();
    fireEvent.click(screen.getByTestId("hermes-import-run"));

    await screen.findByTestId("hermes-import-result");
    expect(runMock).toHaveBeenCalledExactlyOnceWith({
      directory: "~/.hermes/profiles/acme",
      identityId: null,
      title: "Hermes (acme)",
      selectedRelPaths: [
        "SOUL.md",
        "memories/MEMORY.md",
        "memories/USER.md",
        "skills/custom/SKILL.md",
      ],
    });
  });

  it("renders the result rows with each outcome's label, including truncated, and opens the identity", async () => {
    const identity: AgentIdentitySummary = {
      identityId: "identity-1",
      title: "Hermes (acme)",
      description: null,
      updatedAt: 0,
    };
    const response: AgentIdentityHermesRunResponse = {
      kind: "imported",
      identity,
      items: [
        {
          relPath: "SOUL.md",
          outcome: "imported",
          truncated: true,
          detail: "Trimmed to fit.",
        },
        {
          relPath: "memories/MEMORY.md",
          outcome: "imported",
          truncated: false,
          detail: null,
        },
        {
          relPath: "skills/custom/SKILL.md",
          outcome: "skipped",
          truncated: false,
          detail: "Already up to date.",
        },
        {
          relPath: "skills/broken/SKILL.md",
          outcome: "failed",
          truncated: false,
          detail: "Could not read the file.",
        },
      ],
    };
    runMock.mockResolvedValue(response);
    const onOpenIdentity = vi.fn();

    renderPanel(onOpenIdentity);
    await scanProfile();
    fireEvent.click(screen.getByTestId("hermes-import-run"));

    const rows = await screen.findByTestId("hermes-import-result-rows");
    expect(rows.textContent).toContain("Imported, truncated");
    expect(rows.textContent).toContain("Imported");
    expect(rows.textContent).toContain("Skipped");
    expect(rows.textContent).toContain("Failed");

    fireEvent.click(screen.getByTestId("hermes-import-open-identity"));
    expect(onOpenIdentity).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("shows the refusal notice for a refused run response", async () => {
    runMock.mockResolvedValue({
      kind: "refused",
      reason: "capExceeded",
      detail: "too many files",
    });

    renderPanel(null);
    await scanProfile();
    fireEvent.click(screen.getByTestId("hermes-import-run"));

    const refusal = await screen.findByTestId("hermes-import-refusal");
    expect(refusal.textContent).toContain(
      "This identity already holds as many files as it can.",
    );
  });
});

describe("<HermesImportPanel /> target picker", () => {
  it("routes the run through the picked existing identity's id once one is chosen", async () => {
    identitiesListMock.data = {
      identities: [
        {
          identityId: "identity-a",
          title: "Research",
          description: null,
          updatedAt: 0,
        },
        {
          identityId: "identity-b",
          title: "Support",
          description: null,
          updatedAt: 0,
        },
      ],
    };
    runMock.mockResolvedValue({
      kind: "imported",
      identity: {
        identityId: "identity-b",
        title: "Support",
        description: null,
        updatedAt: 0,
      },
      items: [],
    });

    renderPanel(null);
    await scanProfile();

    fireEvent.click(screen.getByTestId("hermes-import-target-existing"));
    fireEvent.click(screen.getByText("Support"));

    expect(screen.getByTestId("hermes-import-summary").textContent).toBe(
      "Import the soul, 2 memory files and 1 skill into “Support”.",
    );

    fireEvent.click(screen.getByTestId("hermes-import-run"));

    await screen.findByTestId("hermes-import-result");
    expect(runMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        identityId: "identity-b",
        title: null,
      }),
    );
  });

  it("forgets the picked existing identity and the typed title on a re-scan", async () => {
    identitiesListMock.data = {
      identities: [
        {
          identityId: "identity-b",
          title: "Support",
          description: null,
          updatedAt: 0,
        },
      ],
    };

    renderPanel(null);
    await scanProfile();

    // Pick an existing identity, then go back to a new one with a typed title.
    fireEvent.click(screen.getByTestId("hermes-import-target-existing"));
    fireEvent.click(screen.getByText("Support"));
    fireEvent.click(screen.getByTestId("hermes-import-target-new"));
    fireEvent.change(screen.getByTestId("hermes-import-title"), {
      target: { value: "Typed" },
    });
    // Before a re-scan, the flip restores the pick.
    fireEvent.click(screen.getByTestId("hermes-import-target-existing"));
    expect(screen.getByTestId("hermes-import-summary").textContent).toBe(
      "Import the soul, 2 memory files and 1 skill into “Support”.",
    );
    fireEvent.click(screen.getByTestId("hermes-import-target-new"));
    const typedTitle = screen.getByTestId(
      "hermes-import-title",
    ) as HTMLInputElement;
    expect(typedTitle.value).toBe("Typed");

    // A re-scan of another profile: the title re-defaults and the existing
    // pick is gone, so the flip lands unpicked and Import stays disabled.
    scanMock.mockResolvedValue({ ...PROFILE_RESPONSE, profileName: "other" });
    fireEvent.click(screen.getByTestId("hermes-import-scan"));
    await waitFor(() => {
      const title = screen.getByTestId(
        "hermes-import-title",
      ) as HTMLInputElement;
      expect(title.value).toBe("Hermes (other)");
    });
    fireEvent.click(screen.getByTestId("hermes-import-target-existing"));
    expect(screen.getByTestId("hermes-import-summary").textContent).toBe(
      "Import the soul, 2 memory files and 1 skill into “the selected identity”.",
    );
    expect(screen.getByTestId("hermes-import-run")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("disables Import for an existing target until an identity is picked", async () => {
    identitiesListMock.data = {
      identities: [
        {
          identityId: "identity-a",
          title: "Research",
          description: null,
          updatedAt: 0,
        },
      ],
    };

    renderPanel(null);
    await scanProfile();

    fireEvent.click(screen.getByTestId("hermes-import-target-existing"));

    expect(screen.getByTestId("hermes-import-run")).toHaveProperty(
      "disabled",
      true,
    );
  });
});
