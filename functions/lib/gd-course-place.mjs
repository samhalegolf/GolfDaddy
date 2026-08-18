/* Where a course is, in words a player recognises.
 *
 * One town and one country per course - enough to tell "Riverside, New Zealand"
 * from "Riverside, United States" in a search list, and no more. Anything
 * finer (street, postcode) is noise on a one-line subtitle and goes stale.
 *
 * Nominatim is the source. It is the same service the picker already searches,
 * so no new dependency and no new key. Its address object names the settlement
 * differently depending on how the place is administered - city, town, village,
 * hamlet, suburb - so the settlement keys are tried in size order rather than
 * assuming one of them is always present.
 *
 * Every function here returns a place or null. A geocoder that is down, rate
 * limited, or answering about the middle of the sea is a normal outcome: the
 * course still works, it just has no subtitle yet.
 */

/* Descending by size. A rural course often has only a village or hamlet, and a
   metro course often has both city and suburb - taking the largest that is
   present keeps the subtitle recognisable rather than hyper-local. */
const SETTLEMENT_KEYS = [
  "city",
  "town",
  "municipality",
  "village",
  "hamlet",
  "suburb",
  "county"
];

function trim(value, max) {
  const clean = value == null ? "" : String(value).trim();
  return max ? clean.slice(0, max) : clean;
}

/* Turn a Nominatim `address` object into a place, or null if it names no
   country. A place with a town but no country is not useful on its own - the
   town name alone is exactly the ambiguity this feature exists to remove. */
export function placeFromAddress(address) {
  if (!address || typeof address !== "object") return null;
  const country = trim(address.country, 80);
  const countryCode = trim(address.country_code, 8).toUpperCase();
  if (!country && !countryCode) return null;
  let locality = "";
  for (const key of SETTLEMENT_KEYS) {
    locality = trim(address[key], 120);
    if (locality) break;
  }
  return { locality, country, countryCode };
}

/* "Auckland, New Zealand", or just the country when the settlement is unknown,
   or "" when nothing is known. Callers render the empty string as no subtitle
   rather than an empty separator. */
export function placeLabel(place) {
  if (!place || typeof place !== "object") return "";
  const locality = trim(place.locality, 120);
  const country = trim(place.country, 80) || trim(place.countryCode, 8).toUpperCase();
  return [locality, country].filter(Boolean).join(", ");
}

/* Reverse geocode a point. Best effort by contract: any failure resolves to
   null so a caller can never be made to fail because the geocoder did.
   Nominatim's usage policy asks for an identifying User-Agent and no more than
   one request a second - the caller owns the pacing, this owns the identity. */
export async function reverseGeocodePlace(lat, lng, opts = {}) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (typeof fetch !== "function") return null;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 4000;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    /* zoom=10 asks for the town/city level. Asking for more detail returns a
       street the subtitle would throw away, and costs the geocoder more. */
    const url = "https://nominatim.openstreetmap.org/reverse"
      + "?format=jsonv2&addressdetails=1&zoom=10"
      + "&lat=" + encodeURIComponent(latitude)
      + "&lon=" + encodeURIComponent(longitude);
    const response = await fetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: {
        Accept: "application/json",
        "User-Agent": trim(opts.userAgent, 200) || "ClarityCaddy/1.0 (samhalegolf@gmail.com)"
      }
    });
    if (!response.ok) return null;
    const body = await response.json();
    return placeFromAddress(body && body.address);
  } catch (_error) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* Read place fields off a course object however the client spelled them.
   The picker sends camelCase, a Supabase row is snake_case, and a course that
   round-tripped through course_json can carry either. */
export function placeFromCourse(input) {
  if (!input || typeof input !== "object") return null;
  const locality = trim(input.locality || input.courseLocality || input.town || input.city, 120);
  const country = trim(input.country || input.courseCountry, 80);
  const countryCode = trim(input.countryCode || input.country_code || input.courseCountryCode, 8).toUpperCase();
  if (!country && !countryCode && !locality) return null;
  return { locality, country, countryCode };
}
