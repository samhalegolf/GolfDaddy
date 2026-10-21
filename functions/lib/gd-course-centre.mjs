/* One answer to "is this a real place for a course?", used everywhere a course centre is read
   or written.

   Plain Number() is the wrong test: Number(null) and Number("") are both 0, and 0 is finite, so
   a missing coordinate turned into 0,0 - a real-looking point in the Gulf of Guinea. That is how
   a Studio remap (which deliberately passes null coordinates) overwrote Umdoni's centre with 0,0
   and its name with the bare course id. No golf course sits at exactly 0,0, so it is treated as
   "no centre" too, which also stops a row already holding 0,0 from being trusted. */
export function courseCentre(lat, lng) {
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  if (la === 0 && ln === 0) return null;
  return { lat: la, lng: ln };
}
