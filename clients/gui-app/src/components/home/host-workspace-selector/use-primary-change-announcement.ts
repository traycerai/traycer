import { useCallback, useState } from "react";

export interface PrimaryChangeAnnouncement {
  readonly message: string;
  // Monotonically increasing per announcement. Two CONSECUTIVE identical
  // messages (duplicate folder basenames: switch to "repo", remove it,
  // fallback lands on the other "repo") must still both announce - a plain
  // string state would bail in React on the second set and never mutate the
  // live-region DOM, so screen readers would hear nothing.
  readonly seq: number;
}

export function usePrimaryChangeAnnouncement(): {
  readonly announcement: PrimaryChangeAnnouncement | null;
  readonly announcePrimaryChange: (folderName: string) => void;
} {
  const [announcement, setAnnouncement] =
    useState<PrimaryChangeAnnouncement | null>(null);
  const announcePrimaryChange = useCallback((folderName: string): void => {
    setAnnouncement((current) => ({
      message: `${folderName} is now primary`,
      seq: (current?.seq ?? 0) + 1,
    }));
  }, []);
  return { announcement, announcePrimaryChange };
}
