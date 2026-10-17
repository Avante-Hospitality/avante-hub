// Files of a property listing (onboarding form, admin, photo chooser), kept in
// the "property-listing-files" store and read back at /api/property-file?key=.
export function slug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// Saves one file and answers its key.
export async function saveListingFile(store, { listingId, kind, label, fileName, contentType, data }) {
  const key = slug(listingId) + "/" + slug(kind) + "/" + Date.now() + "-" + slug(fileName);
  await store.set(key, data, { metadata: { contentType, fileName, listingId: slug(listingId), kind: slug(kind), label: slug(label) } });
  return key;
}
