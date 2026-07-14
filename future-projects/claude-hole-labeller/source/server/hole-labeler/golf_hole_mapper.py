"""
Golf Course Hole Mapping Workflow
----------------------------------
Given: a satellite snapshot of a golf course (local image file) + the course name.
Output: a hole-number -> location mapping for the satellite image, derived by
visually matching the satellite view against a course layout map found online.

Pipeline:
  1. Claude + web search tool  -> candidate page URLs likely to contain a course map
  2. App scrapes those pages   -> candidate image URLs
  3. Download + screen images  -> "is this an actual course layout diagram?"
  4. For each viable map       -> matching call (satellite + map in one message)
  5. Programmatic validation   -> first candidate producing a clean, complete,
                                  uniquely-numbered hole set wins. No ranking.

Dependencies: pip install anthropic httpx pillow
Env: ANTHROPIC_API_KEY
"""

import base64
import io
import json
import re
import sys

import anthropic
import httpx
from PIL import Image

client = anthropic.Anthropic()
MODEL = "claude-sonnet-4-6"   # good vision + cost; try an Opus model if matching quality is marginal
MAX_CANDIDATE_MAPS = 4        # "tries a couple" — cap how many maps we attempt
EXPECTED_HOLES = 18           # set to 9 for executive courses, or make it a parameter


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def extract_json(text: str):
    """Parse JSON out of a model response, tolerating markdown fences."""
    cleaned = re.sub(r"```(?:json)?|```", "", text).strip()
    # Fall back to grabbing the first {...} or [...] block if there's preamble
    match = re.search(r"(\[.*\]|\{.*\})", cleaned, re.DOTALL)
    return json.loads(match.group(1) if match else cleaned)


def load_image_b64(source) -> tuple[str, str]:
    """
    Accepts a local path or raw bytes. Returns (base64_data, media_type).
    Downscales large images — huge satellite tiles waste tokens without
    helping accuracy, and the API caps image dimensions.
    """
    if isinstance(source, (bytes, bytearray)):
        img = Image.open(io.BytesIO(source))
    else:
        img = Image.open(source)

    img = img.convert("RGB")
    img.thumbnail((1568, 1568))  # no-op if already smaller
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.standard_b64encode(buf.getvalue()).decode(), "image/jpeg"


def image_block(b64: str, media_type: str) -> dict:
    return {"type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": b64}}


def text_of(response) -> str:
    return "".join(b.text for b in response.content if b.type == "text")


# ---------------------------------------------------------------------------
# Step 1: find candidate pages via Claude + web search
# ---------------------------------------------------------------------------

def find_candidate_pages(course_name: str) -> list[str]:
    prompt = (
        f'Search the whole web to find a full-course layout map (hole diagram) for the '
        f'golf course "{course_name}" — do NOT limit yourself to the club\'s own '
        f'website. Good sources: golf directories, booking sites, review sites '
        f'(TripAdvisor visitor photos often show the course map signboard or the back '
        f'of the scorecard), blogs, and news articles. Useful queries: '
        f'"{course_name} course map", "{course_name} hole layout", '
        f'"{course_name} scorecard back", "{course_name} tripadvisor photos". '
        f"Smaller clubs often print the layout on the BACK of their scorecard or on a "
        f"welcome signboard, so photos of those count. "
        f"Respond with ONLY a JSON array (no other text, no markdown) of up to 6 page "
        f"URLs most likely to contain a course layout image."
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
    )
    try:
        urls = extract_json(text_of(resp))
        return [u for u in urls if isinstance(u, str) and u.startswith("http")]
    except (json.JSONDecodeError, AttributeError):
        return []


# ---------------------------------------------------------------------------
# Scorecard distances via Claude + web search (for the distance-match method)
# ---------------------------------------------------------------------------

def find_scorecard_distances(course_name: str):
    """Returns (distances_m, shapes) from the course's scorecard and
    hole-by-hole descriptions, or (None, None).
    distances_m: {hole: meters}; shapes: {hole: "left"|"right"|"straight"}."""
    prompt = (
        f'Search the web for the scorecard AND any hole-by-hole course description '
        f'of the golf course "{course_name}" (club sites label these "hole by hole", '
        f'"course tour", "course guide", or "pro\'s tips" — they usually give each '
        f"hole's distance and shape). Extract per-hole distances for the "
        f"LONGEST standard men's tees, and — when a hole-by-hole guide exists "
        f'(phrases like "dogleg left", "sharp right", "straight away") — each '
        f"hole's shape. Sources: the club website, golf directories, booking "
        f"sites, review photos. Respond ONLY with JSON (no other text): "
        f'{{"found": true/false, "units": "meters" or "yards", '
        f'"holes": {{"1": {{"distance": 345, "shape": "left"}}, '
        f'"2": {{"distance": 410, "shape": null}}, ...}}}} '
        f'where "shape" is "left", "right", "straight", or null when the source '
        f"doesn't say. Set found=false if you cannot locate reliable per-hole "
        f"distances for this specific course. Never invent numbers."
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=1600,
        messages=[{"role": "user", "content": prompt}],
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
    )
    try:
        data = extract_json(text_of(resp))
    except (json.JSONDecodeError, AttributeError):
        return None, None
    if not data.get("found"):
        return None, None
    dist, shapes = {}, {}
    try:
        for k, v in (data.get("holes") or {}).items():
            n = int(k)
            dist[n] = float(v["distance"])
            s = str(v.get("shape") or "").lower()
            if s in ("left", "right", "straight"):
                shapes[n] = s
    except (TypeError, ValueError, KeyError):
        return None, None
    if not dist:
        return None, None
    if str(data.get("units", "")).lower().startswith("yard"):
        dist = {k: v * 0.9144 for k, v in dist.items()}
    return dist, shapes


# ---------------------------------------------------------------------------
# Step 2: scrape candidate image URLs from those pages
# ---------------------------------------------------------------------------

IMG_EXT = re.compile(r'https?://[^\s"\'<>]+\.(?:png|jpe?g|webp)', re.IGNORECASE)
# src/href/data-src/og:image content attrs; tolerates relative URLs + query strings
ATTR_IMG = re.compile(
    r'(?:src|href|data-src|data-lazy-src|data-original|content)\s*=\s*'
    r'["\']([^"\']+?\.(?:png|jpe?g|webp)(?:\?[^"\']*)?)["\']', re.IGNORECASE)
SRCSET = re.compile(r'srcset\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)
MAP_HINTS = ("map", "layout", "course", "hole", "aerial", "overview",
             "scorecard", "score-card", "card")
MAX_IMAGES_PER_PAGE = 8   # unhinted fallback cap; screening does the real vetting
MAX_IMAGES_TOTAL = 30


def scrape_image_urls(page_urls: list[str]) -> list[str]:
    """Extract candidate image URLs. Handles relative paths, srcset and
    lazy-load attributes — club websites rarely use absolute image URLs.
    Hinted images (map/layout/scorecard-ish filenames) are queued first."""
    from urllib.parse import urljoin

    found, seen = [], set()

    def add(u: str, base: str):
        u = urljoin(base, u.strip())
        if u.startswith("http") and u not in seen and len(found) < MAX_IMAGES_TOTAL:
            seen.add(u)
            found.append(u)

    with httpx.Client(follow_redirects=True, timeout=15,
                      headers={"User-Agent": "Mozilla/5.0"}) as http:
        for url in page_urls:
            # A search result may already be a direct image link
            if IMG_EXT.fullmatch(url):
                add(url, url)
                continue
            try:
                html = http.get(url).text
            except httpx.HTTPError:
                continue

            hinted, others = [], []
            candidates = [m.group(1) for m in ATTR_IMG.finditer(html)]
            for ss in SRCSET.finditer(html):
                for part in ss.group(1).split(","):
                    u = part.strip().split(" ")[0]
                    if re.search(r"\.(?:png|jpe?g|webp)", u, re.IGNORECASE):
                        candidates.append(u)
            candidates.extend(IMG_EXT.findall(html))
            for u in candidates:
                (hinted if any(h in u.lower() for h in MAP_HINTS) else others).append(u)

            for u in hinted:
                add(u, url)
            # No hinted names on this page: take a few unhinted images anyway —
            # the vision screening call is the real filter.
            if not hinted:
                for u in others[:MAX_IMAGES_PER_PAGE]:
                    add(u, url)
    return found


# ---------------------------------------------------------------------------
# Step 3: screen each image — is it actually a course layout diagram?
# ---------------------------------------------------------------------------

def screen_candidate(img_b64: str, media_type: str, course_name: str) -> bool:
    prompt = (
        f"Is this image an actual golf course layout map/diagram for a full course "
        f"(plausibly {course_name})? It should show multiple holes with fairways/greens "
        f"in their spatial arrangement — not a single-hole graphic, logo, a scorecard "
        f"that is ONLY a numbers table, or an unrelated photo. NOTE: the back of a "
        f"scorecard often carries the full course layout — that counts as a course "
        f"map as long as the hole diagram with numbers is visible. Respond ONLY with "
        f'JSON: {{"is_course_map": true/false, "has_hole_numbers": true/false}}'
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=200,
        messages=[{"role": "user",
                   "content": [image_block(img_b64, media_type),
                               {"type": "text", "text": prompt}]}],
    )
    try:
        verdict = extract_json(text_of(resp))
        # A map without printed hole numbers can't anchor the numbering — skip it
        return bool(verdict.get("is_course_map")) and bool(verdict.get("has_hole_numbers"))
    except json.JSONDecodeError:
        return False


# ---------------------------------------------------------------------------
# Step 4: the matching call — satellite + map in a single message
# ---------------------------------------------------------------------------

def match_holes(sat_b64, sat_type, map_b64, map_type, course_name: str) -> dict:
    prompt = f"""You are given two images of the golf course "{course_name}":
1. FIRST image: a satellite snapshot.
2. SECOND image: a course layout map with numbered holes.

Task: identify each hole in the SATELLITE image by matching its spatial position,
shape, and orientation against the numbered layout map. The two images may differ
in rotation, scale, and cropping — anchor on distinctive features first (clubhouse,
water hazards, dogleg shapes, boundary roads) to establish orientation, then
propagate hole numbers from those anchors.

Respond with ONLY this JSON (no other text, no markdown):
{{
  "success": true/false,
  "orientation_note": "how the map is rotated/scaled relative to the satellite image",
  "holes": [
    {{
      "number": 1,
      "center": {{"x": 0.0-1.0, "y": 0.0-1.0}},   // normalized coords in the SATELLITE image, origin top-left
      "tee_to_green_direction": "e.g. plays roughly west to east",
      "description": "brief locator, e.g. 'long dogleg-left along the northern boundary'"
    }}
  ],
  "unmatched": [list of hole numbers you could NOT confidently place]
}}

Set "success" to false if you cannot establish a reliable orientation between the
two images, or if the layout map does not appear to depict this course. Do not
guess: any hole you are not reasonably confident about belongs in "unmatched"."""
    resp = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        messages=[{"role": "user",
                   "content": [image_block(sat_b64, sat_type),
                               image_block(map_b64, map_type),
                               {"type": "text", "text": prompt}]}],
    )
    return extract_json(text_of(resp))


# ---------------------------------------------------------------------------
# Step 5: binary validation — "clean numbered output" or discard
# ---------------------------------------------------------------------------

def is_clean(result: dict, expected: int = EXPECTED_HOLES) -> bool:
    if not result.get("success"):
        return False
    holes = result.get("holes", [])
    numbers = [h.get("number") for h in holes]
    if sorted(numbers) != list(range(1, expected + 1)):
        return False  # missing, duplicate, or out-of-range hole numbers
    if result.get("unmatched"):
        return False
    for h in holes:
        c = h.get("center", {})
        if not (0 <= c.get("x", -1) <= 1 and 0 <= c.get("y", -1) <= 1):
            return False
    return True


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def map_course_holes(satellite_path: str, course_name: str) -> dict | None:
    sat_b64, sat_type = load_image_b64(satellite_path)

    pages = find_candidate_pages(course_name)
    if not pages:
        return None
    image_urls = scrape_image_urls(pages)

    attempted = 0
    with httpx.Client(follow_redirects=True, timeout=15,
                      headers={"User-Agent": "Mozilla/5.0"}) as http:
        for img_url in image_urls:
            if attempted >= MAX_CANDIDATE_MAPS:
                break
            try:
                raw = http.get(img_url).content
                map_b64, map_type = load_image_b64(raw)
            except Exception:
                continue

            if not screen_candidate(map_b64, map_type, course_name):
                continue

            attempted += 1
            try:
                result = match_holes(sat_b64, sat_type, map_b64, map_type, course_name)
            except (json.JSONDecodeError, anthropic.APIError):
                continue

            if is_clean(result):
                result["source_map_url"] = img_url
                return result  # first clean output wins — no ranking

    return None  # nothing produced a clean mapping


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: python golf_hole_mapper.py <satellite_image> <course name>")
        sys.exit(1)

    mapping = map_course_holes(sys.argv[1], sys.argv[2])
    if mapping is None:
        print("No candidate map produced a clean hole mapping.")
        sys.exit(2)
    print(json.dumps(mapping, indent=2))
