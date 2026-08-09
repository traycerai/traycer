import {
  Folder,
  Briefcase,
  Rocket,
  Store,
  ShoppingCart,
  CodeXml,
  GraduationCap,
  MessagesSquare,
  ChartColumn,
  Wrench,
  Globe,
  Package,
  Zap,
  BookOpen,
  Users,
  Star,
  type LucideIcon,
} from "lucide-react";

export const PROFILE_COLORS = [
  { id: "blue", hex: "#3b82f6" },
  { id: "red", hex: "#ef4444" },
  { id: "green", hex: "#22c55e" },
  { id: "orange", hex: "#f97316" },
  { id: "purple", hex: "#a855f7" },
  { id: "pink", hex: "#ec4899" },
  { id: "cyan", hex: "#06b6d4" },
  { id: "yellow", hex: "#eab308" },
] as const;
export type ProfileColorId = (typeof PROFILE_COLORS)[number]["id"];

export function profileColorHex(id: string): string {
  return PROFILE_COLORS.find((c) => c.id === id)?.hex ?? PROFILE_COLORS[0].hex;
}

export const PROFILE_ICONS: ReadonlyArray<{ id: string; Icon: LucideIcon }> = [
  { id: "folder", Icon: Folder },
  { id: "briefcase", Icon: Briefcase },
  { id: "rocket", Icon: Rocket },
  { id: "store", Icon: Store },
  { id: "cart", Icon: ShoppingCart },
  { id: "code", Icon: CodeXml },
  { id: "graduation", Icon: GraduationCap },
  { id: "messages", Icon: MessagesSquare },
  { id: "chart", Icon: ChartColumn },
  { id: "wrench", Icon: Wrench },
  { id: "globe", Icon: Globe },
  { id: "package", Icon: Package },
  { id: "zap", Icon: Zap },
  { id: "book", Icon: BookOpen },
  { id: "users", Icon: Users },
  { id: "star", Icon: Star },
];

export function profileIcon(id: string): LucideIcon {
  return PROFILE_ICONS.find((i) => i.id === id)?.Icon ?? Folder;
}
