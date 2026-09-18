/* One Supabase REST caller for every function that talks to PostgREST.
 *
 * There were fourteen near-identical copies of this, which meant fourteen
 * places that all had the same hole: a transient PostgREST failure surfaced
 * to the caller as a hard error. On 17 Sep the caddy database restarted;
 * PostgREST came back before Postgres did and answered PGRST002 ("Could not
 * query the database for the schema cache") for about ninety seconds. Every
 * request in that window failed outright even though the correct response
 * was simply to wait a moment and ask again.
 *
 * PGRST000 and PGRST002 are emitted BEFORE PostgREST reaches the database -
 * it could not connect, or could not read the schema cache to plan the
 * query. Nothing was executed, so retrying is safe for any method, including
 * writes. That is the whole reason this is keyed on the PostgREST error code
 * and not on the 503 status: a bare 503 from a proxy might have arrived
 * after the write landed, and replaying a POST on that is how you get two
 * rows. Bare 5xx and network faults are therefore retried on GET only.
 */

const RETRY_CODES = new Set(["PGRST000", "PGRST001", "PGRST002"]);
const RETRY_STATUS = new Set([502, 503, 504]);
const ATTEMPTS = 4;
const BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postgrestCode(body) {
  if (!body || typeof body !== "object") return "";
  return String(body.code || "");
}

/* A write may only be replayed when we know the database was never reached. */
function retryable(status, body, method) {
  if (RETRY_CODES.has(postgrestCode(body))) return true;
  const idempotent = !method || String(method).toUpperCase() === "GET";
  return idempotent && RETRY_STATUS.has(status);
}

/* base and key may be values or getters - the functions read them from the
   environment, which is not populated until the handler runs. */
function resolve(source) {
  return String((typeof source === "function" ? source() : source) || "");
}

export function createSupabaseFetch({ base, key, label = "supabase" }) {
  return async function supabaseFetch(path, options = {}) {
    const root = resolve(base).replace(/\/+$/, "");
    const token = resolve(key);
    if (!root || !token) throw new Error("Supabase is not configured");

    const headers = Object.assign({
      apikey: token,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    }, options.headers || {});

    let lastError = null;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetch(root + "/rest/v1/" + path, Object.assign({}, options, { headers }));
      } catch (networkError) {
        lastError = networkError;
        /* No response at all: we cannot tell whether a write landed. */
        if (attempt < ATTEMPTS && retryable(0, null, options.method)) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
          continue;
        }
        throw networkError;
      }

      const bodyText = await response.text();
      let body = null;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch (_error) {
          body = bodyText;
        }
      }

      if (response.ok) return body;

      const error = new Error("Supabase request failed");
      error.status = response.status;
      error.body = body;
      lastError = error;

      if (attempt < ATTEMPTS && retryable(response.status, body, options.method)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          label + ": transient Supabase failure (" + (postgrestCode(body) || response.status) +
          "), retry " + attempt + "/" + (ATTEMPTS - 1) + " in " + delay + "ms"
        );
        await sleep(delay);
        continue;
      }

      throw error;
    }

    throw lastError || new Error("Supabase request failed");
  };
}
