import { createRoot } from "react-dom/client";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import "@/index.css";

/**
 * The real `DrawerContent`, open from the start, so its resolved width is read
 * as the browser lays it out. `?direction=left|right|bottom` picks the side
 * (default `right`) and `?fullWidth=1` passes the prop.
 */
type Direction = "left" | "right" | "bottom";

function readDirection(value: string | null): Direction {
  if (value === "left" || value === "bottom") return value;
  return "right";
}

const query = new URLSearchParams(window.location.search);
const direction = readDirection(query.get("direction"));
const fullWidth = query.get("fullWidth") === "1";

const root = document.getElementById("root");
if (root === null) throw new Error("the fixture needs a #root");
createRoot(root).render(
  <Drawer direction={direction} open modal={false}>
    <DrawerContent data-testid="drawer" fullWidth={fullWidth}>
      <DrawerTitle>Drawer</DrawerTitle>
      <DrawerDescription>Content</DrawerDescription>
    </DrawerContent>
  </Drawer>,
);
