/* One-off cleanup of Millbrook's superseded Watch map packages.
   Dry run by default; set CONFIRM=1 to actually delete. */
const BASE = "https://zcevluithwoumvafhmct.supabase.co";
const BUCKET = "course-watch-maps";
const COURSE = "millbrook-remarkables-18";
const KEEP = "v1788285633006";                 // the live package - never touched
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY is required"); process.exit(1); }
const headers = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

async function list(prefix) {
  const r = await fetch(`${BASE}/storage/v1/object/list/${BUCKET}`, {
    method: "POST", headers,
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } })
  });
  if (!r.ok) throw new Error(`list ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const folders = (await list(COURSE)).map(i => i.name).filter(n => /^v\d+$/.test(n) && n !== KEEP);
const paths = [];
for (const folder of folders) {
  for (const asset of await list(`${COURSE}/${folder}`)) {
    if (/^h\d{1,2}\.(png|webp)$/.test(asset.name)) paths.push(`${COURSE}/${folder}/${asset.name}`);
  }
}
if (paths.some(p => p.includes(KEEP))) { console.error("REFUSING: live package in the delete set"); process.exit(1); }
console.log(`${folders.length} superseded folder(s), ${paths.length} file(s):\n  ${folders.join("\n  ")}`);

if (process.env.CONFIRM !== "1") { console.log("\nDry run. Re-run with CONFIRM=1 to delete."); process.exit(0); }
const r = await fetch(`${BASE}/storage/v1/object/${BUCKET}`, {
  method: "DELETE", headers, body: JSON.stringify({ prefixes: paths })
});
console.log(r.ok ? `Deleted ${paths.length} file(s).` : `Delete failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
