import { describe, expect, it } from "vitest";
import { Eye, FilePen, ShieldCheck, ShieldOff } from "lucide-react";
import {
  AUTO_MID_TURN_NOTICE,
  PERMISSION_MODE_DETAILS,
  PERMISSION_OPTIONS,
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

  // "Risky commands ask you" is the EXCEPTION to the judge item, never a list
  // member: the Modes tab renders every member under "runs without asking",
  // and a member that says the opposite reads as a contradiction.
  it("lists auto's two items, with the risky-command exception on the judge item", () => {
    expect(PERMISSION_MODE_DETAILS.auto).toEqual({
      runsWithoutAsking: [
        { text: "Reads, searches, edits", exception: null },
        {
          text: "Commands the judge approves",
          exception: "risky ones still ask you",
        },
      ],
    });
  });

  it("never lists an item that says it asks, under any mode", () => {
    for (const details of Object.values(PERMISSION_MODE_DETAILS)) {
      for (const item of details.runsWithoutAsking) {
        expect(item.text).not.toMatch(/\bask/iu);
      }
    }
  });

  it("lists full_access's single item verbatim", () => {
    expect(PERMISSION_MODE_DETAILS.full_access).toEqual({
      runsWithoutAsking: [{ text: "Everything, unreviewed", exception: null }],
    });
  });
});
