import { formatCount } from "@/lib/format-count";

/** What the download confirm says, for what the app asked to save and open. */
export interface McpAppDownloadCopy {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
}

function counted(count: number, one: string, many: string): string {
  return count === 1 ? `this ${one}` : `${formatCount(count)} ${many}`;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The confirm's words for `files` embedded files to save and `links` links to
 * open, from the `server` app: "Save this file?", "Open 2 links?", "Save 3
 * files and open 2 links?", and a button that names the same verbs.
 */
export function mcpAppDownloadCopy(
  server: string,
  files: number,
  links: number,
): McpAppDownloadCopy {
  const save = counted(files, "file", "files");
  const open = counted(links, "link", "links");
  if (links === 0) {
    return {
      title: `${capitalized(`save ${save}`)}?`,
      description: `The ${server} app wants to save:`,
      confirm: "Save",
    };
  }
  if (files === 0) {
    return {
      title: `${capitalized(`open ${open}`)}?`,
      description: `The ${server} app wants to open:`,
      confirm: "Open",
    };
  }
  return {
    title: `Save ${save} and open ${open}?`,
    description: `The ${server} app wants to save and open:`,
    confirm: "Save and open",
  };
}
