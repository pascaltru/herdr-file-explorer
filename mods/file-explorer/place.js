// Where the explorer sits in the person's layout, found by its block's mod rather than by node ids,
// so it works in any layout. In a pane or a floating block it isn't in layout(): these do nothing.
import { layout, run } from "herdr";
import { NAME } from "./menus.js";

// The nodes from the layout's root down to the explorer's block, or null.
function blockPath(node = layout(), path = []) {
  if (!node) return null;
  const here = [...path, node];
  if (node.content?.mod === NAME) return here;
  for (const child of node.children ?? []) {
    const found = blockPath(child, here);
    if (found) return found;
  }
  return null;
}

// Whether an explorer block is on screen: nothing above it hidden, and the shown child of each stack.
export function shownIn(node = layout()) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === NAME) return true;
  const kids = node.children ?? [];
  if (node.type === "stack") return shownIn(kids.find(c => c.id === node.active) ?? kids[0]);
  return kids.some(child => shownIn(child));
}

// Brings the explorer on screen: each stack above it shows its branch, and hidden nodes are shown.
export function showBlock() {
  const path = blockPath();
  if (!path) return;
  path.forEach((node, i) => {
    const next = path[i + 1];
    if (node.type === "stack" && next?.id && node.active !== next.id) run("layout.select", { stack: node.id, child: next.id });
    if (node.hidden && node.id) run("layout.show", { id: node.id });
  });
}

// The node that gives the explorer its width: the nearest one on its path that sits in a row.
export function sizedNode() {
  const path = blockPath();
  if (!path) return null;
  for (let i = path.length - 1; i > 0; i--) if (path[i - 1].type === "row" && path[i].id) return path[i];
  return null;
}
