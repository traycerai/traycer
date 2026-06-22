import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
} from "@pierre/trees";
import { useMemo, type CSSProperties } from "react";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { cn } from "@/lib/utils";

interface WorkspaceResolvedFileIcon {
  readonly height?: number;
  readonly name: string;
  readonly token?: string;
  readonly viewBox?: string;
  readonly width?: number;
}

const workspaceFileIconResolver = createFileTreeIconResolver({
  set: "complete",
});
const WORKSPACE_FILE_ICON_SPRITE_SHEET = getBuiltInSpriteSheet("complete");

// Sprite sheet hosts the `<symbol>` defs that every `WorkspaceFileIcon`
// references via `<use href="#...">`. It must live in the DOM for the lifetime
// of every consumer (tab strip, DnD overlay, file-tree panel). Mounted once at
// the epic-canvas root (see `epic-shell.tsx`) so consumers never need to think
// about it.
export function WorkspaceFileIconSpriteSheet() {
  // `trustedMarkupToReactNodes` runs DOMPurify.sanitize + a full DOM walk over
  // the (large, STATIC) sprite-sheet markup. The input is a module constant, so
  // the output never changes - memoize it so a re-render of this component (when
  // `EpicShell` re-renders) doesn't re-sanitize the whole sheet (~19ms self in a
  // tile-open commit).
  const spriteSheet = useMemo(
    () => trustedMarkupToReactNodes(WORKSPACE_FILE_ICON_SPRITE_SHEET, "svg"),
    [],
  );
  return (
    <span aria-hidden="true" className="hidden">
      {spriteSheet}
    </span>
  );
}

export function WorkspaceFileIcon(props: {
  readonly fileName: string;
  readonly className: string | undefined;
}) {
  const icon: WorkspaceResolvedFileIcon = workspaceFileIconResolver.resolveIcon(
    "file-tree-icon-file",
    props.fileName,
  );
  const href = `#${icon.name.replace(/^#/, "")}`;
  const viewBox =
    icon.viewBox ??
    `0 0 ${String(icon.width ?? 16)} ${String(icon.height ?? 16)}`;
  const style: CSSProperties | undefined =
    icon.token === undefined
      ? undefined
      : {
          color: `var(--trees-file-icon-color-${icon.token}, ${
            FILE_TREE_ICON_COLOR_FALLBACKS[icon.token] ??
            "var(--muted-foreground)"
          })`,
        };

  return (
    <svg
      aria-hidden="true"
      data-icon-name={icon.name}
      data-icon-token={icon.token}
      viewBox={viewBox}
      width={icon.width ?? 16}
      height={icon.height ?? 16}
      className={cn("shrink-0 text-muted-foreground", props.className)}
      style={style}
    >
      <use href={href} />
    </svg>
  );
}

const FILE_TREE_ICON_COLOR_FALLBACKS: Readonly<Record<string, string>> = {
  astro: "light-dark(#a631be, #d568ea)",
  babel: "light-dark(#d5a910, #ffd452)",
  bash: "light-dark(#199f43, #5ecc71)",
  biome: "light-dark(#1a85d4, #69b1ff)",
  bootstrap: "light-dark(#693acf, #9d6afb)",
  browserslist: "light-dark(#d5a910, #ffd452)",
  bun: "light-dark(#594c5b, #79697b)",
  c: "light-dark(#1a85d4, #69b1ff)",
  claude: "light-dark(#d47628, #ffa359)",
  cpp: "light-dark(#1a85d4, #69b1ff)",
  css: "light-dark(#693acf, #9d6afb)",
  database: "light-dark(#a631be, #d568ea)",
  default: "light-dark(#84848a, #adadb1)",
  docker: "light-dark(#1a85d4, #69b1ff)",
  eslint: "light-dark(#693acf, #9d6afb)",
  git: "light-dark(#ff8c5b, #d5512f)",
  go: "light-dark(#1ca1c7, #68cdf2)",
  graphql: "light-dark(#d32a61, #ff678d)",
  html: "light-dark(#d47628, #ffa359)",
  image: "light-dark(#d32a61, #ff678d)",
  javascript: "light-dark(#d5a910, #ffd452)",
  json: "light-dark(#d47628, #ffa359)",
  markdown: "light-dark(#199f43, #5ecc71)",
  mcp: "light-dark(#17a5af, #64d1db)",
  npm: "light-dark(#d52c36, #ff6762)",
  oxc: "light-dark(#1ca1c7, #68cdf2)",
  postcss: "light-dark(#d52c36, #ff6762)",
  prettier: "light-dark(#17a5af, #64d1db)",
  python: "light-dark(#1a85d4, #69b1ff)",
  react: "light-dark(#1ca1c7, #68cdf2)",
  ruby: "light-dark(#d52c36, #ff6762)",
  rust: "light-dark(#d47628, #ffa359)",
  sass: "light-dark(#d32a61, #ff678d)",
  svg: "light-dark(#d47628, #ffa359)",
  svelte: "light-dark(#d52c36, #ff6762)",
  svgo: "light-dark(#199f43, #5ecc71)",
  swift: "light-dark(#d47628, #ffa359)",
  table: "light-dark(#17a5af, #64d1db)",
  tailwind: "light-dark(#1ca1c7, #68cdf2)",
  terraform: "light-dark(#693acf, #9d6afb)",
  text: "light-dark(#84848a, #adadb1)",
  typescript: "light-dark(#1a85d4, #69b1ff)",
  vite: "light-dark(#a631be, #d568ea)",
  vscode: "light-dark(#1a85d4, #69b1ff)",
  vue: "light-dark(#199f43, #5ecc71)",
  wasm: "light-dark(#693acf, #9d6afb)",
  webpack: "light-dark(#1a85d4, #69b1ff)",
  yml: "light-dark(#d52c36, #ff6762)",
  zig: "light-dark(#d47628, #ffa359)",
  zip: "light-dark(#d47628, #ffa359)",
};
