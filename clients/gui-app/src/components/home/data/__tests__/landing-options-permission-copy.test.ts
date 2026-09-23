import { describe, expect, it } from "vitest";
import { Eye, FilePen, ShieldCheck, ShieldOff } from "lucide-react";
import {
  AUTO_MID_TURN_NOTICE,
  PERMISSION_MODE_DETAILS,
  PERMISSION_OPTIONS,
  permissionModeDetailLine,
} from "@/components/home/data/landing-options";

describe("PERMISSION_OPTIONS - labels, descriptions and icons", () => {
  it("keeps the four modes in most-restrictive-to-most-permissive order", () => {
    expect(PERMISSION_OPTIONS.map((option) => option.id)).toEqual([
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ]);
  });

  it("pairs each mode with its label, one-line description and icon", () => {
    expect(PERMISSION_OPTIONS).toEqual([
      {
        id: "supervised",
        label: "Supervised",
        description: "Asks before every command and file change.",
        icon: Eye,
      },
      {
        id: "auto_accept_edits",
        label: "Auto-accept edits",
        description: "Edits go through. Commands still ask.",
        icon: FilePen,
      },
      {
        id: "auto",
        label: "Auto",
        description:
          "A judge approves routine commands and asks you about risky ones.",
        icon: ShieldCheck,
      },
      {
        id: "full_access",
        label: "Full access",
        description: "Runs everything. Nothing asks.",
        icon: ShieldOff,
      },
    ]);
  });
});

describe("AUTO_MID_TURN_NOTICE", () => {
  it("is the exact sentence", () => {
    expect(AUTO_MID_TURN_NOTICE).toBe(
      "Switches now. Anything already waiting still asks you.",
    );
  });
});

describe("PERMISSION_MODE_DETAILS", () => {
  it("lists supervised's single item verbatim", () => {
    expect(PERMISSION_MODE_DETAILS.supervised).toEqual({
      runsWithoutAsking: [{ text: "Reads and searches", exception: null }],
    });
  });

  it("lists auto_accept_edits's items, including the guarded-path exception", () => {
    expect(PERMISSION_MODE_DETAILS.auto_accept_edits).toEqual({
      runsWithoutAsking: [
        { text: "Reads and searches", exception: null },
        {
          text: "File edits in the workspace",
          exception: "config, scripts and git internals still ask",
        },
      ],
    });
  });

  it("lists auto's three items verbatim", () => {
    expect(PERMISSION_MODE_DETAILS.auto).toEqual({
      runsWithoutAsking: [
        { text: "Reads, searches, edits", exception: null },
        { text: "Commands the judge approves", exception: null },
        { text: "Risky commands ask you", exception: null },
      ],
    });
  });

  it("lists full_access's single item verbatim", () => {
    expect(PERMISSION_MODE_DETAILS.full_access).toEqual({
      runsWithoutAsking: [{ text: "Everything, unreviewed", exception: null }],
    });
  });
});

describe("permissionModeDetailLine", () => {
  it("renders the bare text when there is no exception", () => {
    expect(
      permissionModeDetailLine({ text: "Reads and searches", exception: null }),
    ).toBe("Reads and searches");
  });

  it("appends the exception in parentheses when one is present", () => {
    expect(
      permissionModeDetailLine({
        text: "File edits in the workspace",
        exception: "config, scripts and git internals still ask",
      }),
    ).toBe(
      "File edits in the workspace (config, scripts and git internals still ask)",
    );
  });
});
