export const themeQueryKeys = {
  search: (query: string, sort: string) =>
    ["themes", "open-vsx", query, sort] as const,
  import: () => ["themes", "import"] as const,
};
