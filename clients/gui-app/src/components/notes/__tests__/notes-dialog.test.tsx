import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NotesHeaderControl } from "@/components/notes/notes-header-control";
import { useProjectNotesStore } from "@/stores/workspace/project-notes-store";
import { useProjectProfilesStore } from "@/stores/workspace/project-profiles-store";

const HOST = "host-a";

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST,
}));

function mount() {
  render(
    <TooltipProvider>
      <NotesHeaderControl />
    </TooltipProvider>,
  );
}

function seed() {
  const titanos = useProjectProfilesStore.getState().createProfile(HOST, {
    name: "Titanos",
    color: "orange",
    folderPaths: ["/titanos"],
    primaryPath: "/titanos",
  });
  const crm = useProjectProfilesStore.getState().createProfile(HOST, {
    name: "CRM",
    color: "blue",
    folderPaths: ["/crm"],
    primaryPath: "/crm",
  });
  useProjectNotesStore.getState().createNote(HOST, {
    title: "Buy milk",
    body: "2 liters",
    scope: { kind: "general" },
  });
  useProjectNotesStore.getState().createNote(HOST, {
    title: "Ads budget",
    body: "cut spend",
    scope: { kind: "project", profileId: titanos ?? "" },
  });
  useProjectNotesStore.getState().createNote(HOST, {
    title: "Inbox SLA",
    body: "reply in 1h",
    scope: { kind: "project", profileId: crm ?? "" },
  });
  return { titanos, crm };
}

describe("<NotesHeaderControl />", () => {
  beforeEach(() => {
    useProjectProfilesStore.setState({ byHost: {} });
    useProjectNotesStore.setState({ byHost: {} });
  });

  afterEach(() => {
    cleanup();
    useProjectProfilesStore.setState({ byHost: {} });
    useProjectNotesStore.setState({ byHost: {} });
  });

  it("hides another project's note while Titanos is active", () => {
    const { titanos } = seed();
    useProjectProfilesStore.getState().setActiveProfile(HOST, titanos);
    mount();
    fireEvent.click(screen.getByTestId("notes-button"));
    expect(screen.getByTestId("notes-dialog").textContent).toContain("Buy milk");
    expect(screen.getByTestId("notes-dialog").textContent).toContain(
      "Ads budget",
    );
    expect(screen.getByTestId("notes-dialog").textContent).not.toContain(
      "Inbox SLA",
    );
  });

  it("does not leak a hidden project note through search", () => {
    const { titanos } = seed();
    useProjectProfilesStore.getState().setActiveProfile(HOST, titanos);
    mount();
    fireEvent.click(screen.getByTestId("notes-button"));
    fireEvent.change(screen.getByTestId("notes-search"), {
      target: { value: "Inbox" },
    });
    expect(screen.getByTestId("notes-dialog").textContent).not.toContain(
      "Inbox SLA",
    );
  });

  it("shows every project's notes on All projects", () => {
    seed();
    useProjectProfilesStore.getState().setActiveProfile(HOST, null);
    mount();
    fireEvent.click(screen.getByTestId("notes-button"));
    expect(screen.getByTestId("notes-dialog").textContent).toContain(
      "Inbox SLA",
    );
  });

  it("opens a new note scoped to the active project", () => {
    const { titanos } = seed();
    useProjectProfilesStore.getState().setActiveProfile(HOST, titanos);
    mount();
    fireEvent.click(screen.getByTestId("notes-button"));
    fireEvent.click(screen.getByTestId("notes-new"));
    expect(screen.getByTestId("note-editor")).toBeTruthy();
    expect(screen.getByTestId("note-scope")).toHaveProperty("value", titanos);
  });

  it("keeps a newer title when the store echoes the previous save", () => {
    const { titanos } = seed();
    useProjectProfilesStore.getState().setActiveProfile(HOST, titanos);
    mount();
    fireEvent.click(screen.getByTestId("notes-button"));
    fireEvent.click(screen.getByRole("button", { name: "Ads budget" }));
    const notes = useProjectNotesStore.getState().byHost[HOST].notes;
    const noteId =
      notes.find((note) => note.title === "Ads budget")?.id ?? "";
    const title = screen.getByTestId("note-title");
    fireEvent.change(title, { target: { value: "First" } });
    fireEvent.change(title, { target: { value: "Second" } });
    act(() => {
      useProjectNotesStore.getState().updateNote(HOST, noteId, {
        title: "First",
        body: "cut spend",
        scope: { kind: "project", profileId: titanos ?? "" },
      });
    });
    expect(title).toHaveProperty("value", "Second");
  });

  it("asks before deleting and keeps the note on cancel", () => {
    const { titanos } = seed();
    useProjectProfilesStore.getState().setActiveProfile(HOST, titanos);
    mount();
    fireEvent.click(screen.getByTestId("notes-button"));
    fireEvent.click(screen.getByRole("button", { name: "Ads budget" }));
    fireEvent.click(screen.getByTestId("note-delete"));
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    const notes = useProjectNotesStore.getState().byHost[HOST].notes;
    expect(notes.some((note) => note.title === "Ads budget")).toBe(true);
  });
});
