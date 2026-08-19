/* Where a course is, in words a player recognises.
 *
 * One region and one country per course - enough to tell "Riverside, Otago"
 * from "Riverside, California" in a search list, and no more. Anything finer
 * goes stale and does not fit a one-line subtitle.
 *
 * Region rather than town, which is not the obvious choice and was not the
 * first one. Nominatim's settlement fields answer "which body administers
 * this point", not "what do people call here". Reverse geocoding the real
 * course database returned Kaipātiki for Takapuna, Puketāpapa for Akarana,
 * Rodney for Helensville - correct local-board names that no golfer uses.
 * The state/region field gave Auckland, Otago, Waikato, California, Scotland,
 * Queensland: recognisable everywhere, and present on every course tried.
 *
 * The cost is precision in big cities - Los Angeles Country Club reads
 * "California, United States". That is the accepted trade: a subtitle exists
 * to disambiguate courses, and country plus region does that in every case
 * this database contains.
 *
 * Every function here returns a place or null. A geocoder that is down, rate
 * limited, or answering about the middle of the sea is a normal outcome: the
 * course still works, it just has no subtitle yet.
 */

/* Descending by size, stopping at the first hit. state is the intended answer;
   the rest are fallbacks for places that have no state - small countries and
   city-states file the equivalent under region or district, and a city-state
   proper (Singapore, Monaco) only has a city. */
const REGION_KEYS = [
  "state",
  "region",
  "state_district",
  "county",
  "city",
  "town",
  "municipality",
  "village"
];

function trim(value, max) {
  const clean = value == null ? "" : String(value).trim();
  return max ? clean.slice(0, max) : clean;
}

/* Turn a Nominatim `address` object into a place, or null if it names no
   country. A region with no country is not useful on its own - "Auckland"
   alone is exactly the ambiguity this feature exists to remove. */
export function placeFromAddress(address) {
  if (!address || typeof address !== "object") return null;
  const country = trim(address.country, 80);
  const countryCode = trim(address.country_code, 8).toUpperCase();
  if (!country && !countryCode) return null;
  let region = "";
  for (const key of REGION_KEYS) {
    region = trim(address[key], 120);
    if (region) break;
  }
  return { region, country, countryCode };
}

/* "Auckland, New Zealand", or just the country when the region is unknown, or
   "" when nothing is known. Callers render the empty string as no subtitle
   rather than an empty separator. */
export function placeLabel(place) {
  if (!place || typeof place !== "object") return "";
  const region = trim(place.region, 120);
  const country = trim(place.country, 80) || trim(place.countryCode, 8).toUpperCase();
  return [region, country].filter(Boolean).join(", ");
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
    /* zoom=10 asks for the town/city level, which is where the state field is
       reliably populated. accept-language=en pins the country name: without it
       New Zealand comes back as "New Zealand / Aotearoa", which is correct but
       not what belongs on a one-line subtitle. */
    const url = "https://nominatim.openstreetmap.org/reverse"
      + "?format=jsonv2&addressdetails=1&accept-language=en&zoom=10"
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
  const region = trim(input.region || input.courseRegion || input.state, 120);
  const country = trim(input.country || input.courseCountry, 80);
  const countryCode = trim(input.countryCode || input.country_code || input.courseCountryCode, 8).toUpperCase();
  if (!country && !countryCode && !region) return null;
  return { region, country, countryCode };
}
