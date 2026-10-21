// Where the hub keeps its live location-tree placements (the "tree-places"
// store: activities and properties placed by Google, see lib/tree.js).
// Kept apart from lib/tree.js so a function that only reads or writes the
// store doesn't have to load the tree engine and its 300KB of region data
// (lib/tree-data.js); lib/tree.js re-exports these.
export const PLACES_STORE = "tree-places";
export const ACTIVITY_KEY = "activities";
export const PROPERTY_KEY = "properties";

// The tree engine, loaded the first time a function needs it (placing a pin,
// the tree rules) and then kept for the isolate's life. A dynamic import with
// a fixed string is still bundled with the function.
let treeModule = null;
export async function loadTree() {
  if (!treeModule) treeModule = await import("./tree.js");
  return treeModule;
}
