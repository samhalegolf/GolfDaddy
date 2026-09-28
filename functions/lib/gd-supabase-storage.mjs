/* The four Storage calls the mapper side needs, over one bucket, with the service key.
 *
 * course-visual-worker-background.mjs carries its own copies of upload/list/remove
 * for the same bucket; they are unchanged here and can move onto this when that
 * worker is next touched. deps are the same shape (base(), key()) as
 * createSupabaseFetch so a caller configures both from one place. */
export function createSupabaseStorage({ base, key, bucket }) {
  const root = () => String(base() || "").replace(/\/+$/, "");
  const auth = () => ({ apikey: key(), Authorization: "Bearer " + key() });
  return {
    async upload(path, buffer, contentType) {
      const response = await fetch(root() + "/storage/v1/object/" + bucket + "/" + path, {
        method: "POST",
        headers: Object.assign({ "Content-Type": contentType, "x-upsert": "true" }, auth()),
        body: buffer
      });
      if (!response.ok) throw new Error("Storage upload " + response.status + " for " + path + ": " + (await response.text()).slice(0, 300));
      return path;
    },
    async list(prefix) {
      const response = await fetch(root() + "/storage/v1/object/list/" + bucket, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, auth()),
        body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } })
      });
      if (!response.ok) throw new Error("Storage list " + response.status + " for " + prefix);
      const rows = await response.json();
      return Array.isArray(rows) ? rows : [];
    },
    async remove(paths) {
      if (!paths.length) return;
      const response = await fetch(root() + "/storage/v1/object/" + bucket, {
        method: "DELETE",
        headers: Object.assign({ "Content-Type": "application/json" }, auth()),
        body: JSON.stringify({ prefixes: paths })
      });
      if (!response.ok) throw new Error("Storage remove " + response.status + ": " + (await response.text()).slice(0, 200));
    },
    publicUrl(path) {
      return root() + "/storage/v1/object/public/" + bucket + "/" + String(path).split("/").map(encodeURIComponent).join("/");
    }
  };
}
