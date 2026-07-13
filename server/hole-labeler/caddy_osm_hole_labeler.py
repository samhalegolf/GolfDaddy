"""
GolfDaddy — OSM Hole Labeler Service
-------------------------------------
For courses whose OSM data has golf=hole geometry but no ref (hole number) tags.

Pipeline:
  1. Query Overpass for golf=hole ways/relations around the course center
     (same query shape as gd-course-library-pin-lock.js uses).
  2. Render a georeferenced schematic: each unlabeled hole polyline drawn over
     satellite tiles, tagged with a letter (A, B, C, ...).
  3. Claude + web search finds the official course layout map online and screens
     candidates (reuses golf_hole_mapper.py).
  4. Matching call: schematic + official map -> {"A": 5, "B": 12, ...}.
  5. Binary validation; first clean assignment wins.
Returns {"labels": {"way-123456": 4, ...}} keyed the same way the app keys
guide ids (`${element.type}-${element.id}`), ready to inject as tags.ref.

Deps: pip install fastapi uvicorn anthropic httpx pillow
Run:  ANTHROPIC_API_KEY=... uvicorn caddy_osm_hole_labeler:app --port 8000

Env:
  ANTHROPIC_API_KEY          required — Claude API key
  ALLOWED_ORIGINS            comma-separated CORS origins
                             (default: https://clarity-caddie.netlify.app)
  SUPABASE_URL               optional — enables persistent label cache
  SUPABASE_SERVICE_ROLE_KEY  optional — service-role key for hole_label_cache

With Supabase configured, results persist in public.hole_label_cache and the
Claude pipeline runs roughly once per course, ever. Without it, the cache is
in-memory only (per-worker, lost on restart). JOBS stay in-memory: jobs are
transient (client polls for ~3 min), fine for a single-instance deploy.
"""

import io
import json
import math
import os
import re
import threading
import uuid
import base64

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel

import golf_hole_mapper as mapper

app = FastAPI(title="GolfDaddy OSM Hole Labeler")

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://clarity-caddie.netlify.app"
).split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])

JOBS: dict[str, dict] = {}
CACHE: dict[str, dict] = {}  # in-memory fallback / hot layer over Supabase
LOCK = threading.Lock()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
CACHE_TABLE = "hole_label_cache"


def _sb_headers() -> dict:
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}


def cache_get(cache_key: str):
    """In-memory first, then Supabase (if configured)."""
    with LOCK:
        hit = CACHE.get(cache_key)
    if hit is not None:
        return hit
    if not (SUPABASE_URL and SUPABASE_KEY):
        return None
    try:
        r = httpx.get(f"{SUPABASE_URL}/rest/v1/{CACHE_TABLE}",
                      params={"cache_key": f"eq.{cache_key}", "select": "result"},
                      headers=_sb_headers(), timeout=10)
        r.raise_for_status()
        rows = r.json()
        if rows:
            result = rows[0]["result"]
            with LOCK:
                CACHE[cache_key] = result
            return result
    except Exception as exc:
        print(f"supabase cache read failed ({cache_key}): {exc}")
    return None


def cache_put(cache_key: str, result: dict):
    with LOCK:
        CACHE[cache_key] = result
    if not (SUPABASE_URL and SUPABASE_KEY):
        return
    try:
        httpx.post(
            f"{SUPABASE_URL}/rest/v1/{CACHE_TABLE}",
            headers={**_sb_headers(),
                     "Prefer": "resolution=merge-duplicates"},
            json={"cache_key": cache_key, "result": result},
            timeout=10,
        ).raise_for_status()
    except Exception as exc:
        print(f"supabase cache write failed ({cache_key}): {exc}")

OVERPASS = "https://overpass-api.de/api/interpreter"
TILE_URL = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
            "World_Imagery/MapServer/tile/{z}/{y}/{x}")
CANVAS_W = 1400
EXPECTED_HOLES = 18


# ---------------------------------------------------------------------------
# Overpass: fetch golf=hole geometry (mirrors the app's query)
# ---------------------------------------------------------------------------

def fetch_osm_holes(lat: float, lng: float) -> list[dict]:
    query = (f'[out:json][timeout:18];('
             f'way(around:1400,{lat},{lng})["golf"="hole"];'
             f'relation(around:1400,{lat},{lng})["golf"="hole"];'
             f');out geom tags;')
    resp = httpx.get(OVERPASS, params={"data": query}, timeout=25)
    resp.raise_for_status()
    holes = []
    for el in resp.json().get("elements", []):
        pts = geometry_points(el)
        if len(pts) < 2:
            continue
        holes.append({
            "key": f'{el.get("type", "osm")}-{el.get("id")}',
            "ref": ref_number(el),
            "points": pts,  # [(lat, lng), ...]
        })
    return holes


def geometry_points(el: dict) -> list[tuple[float, float]]:
    pts = []
    for g in el.get("geometry") or []:
        if g and "lat" in g and "lon" in g:
            pts.append((float(g["lat"]), float(g["lon"])))
    for m in el.get("members") or []:
        for g in m.get("geometry") or []:
            pts.append((float(g["lat"]), float(g["lon"])))
    return pts


def ref_number(el: dict):
    """Same tolerance as the app's osmGuideHoleRef: ref, else digits in name."""
    tags = el.get("tags") or {}
    for v in (tags.get("ref"), tags.get("name")):
        m = re.search(r"\d+", str(v or ""))
        if m and 1 <= int(m.group()) <= 36:
            return int(m.group())
    return None


# ---------------------------------------------------------------------------
# Schematic rendering (web mercator, optional satellite tile background)
# ---------------------------------------------------------------------------

def _merc(lat, lng):
    x = (lng + 180.0) / 360.0
    s = math.sin(math.radians(lat))
    y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
    return x, y


def letter_label(i: int) -> str:
    return chr(65 + i) if i < 26 else f"Z{i - 25}"


def render_schematic(holes: list[dict]) -> Image.Image:
    all_pts = [p for h in holes for p in h["points"]]
    xs, ys = zip(*(_merc(lat, lng) for lat, lng in all_pts))
    pad_x = (max(xs) - min(xs)) * 0.08 or 1e-6
    pad_y = (max(ys) - min(ys)) * 0.08 or 1e-6
    x0, x1 = min(xs) - pad_x, max(xs) + pad_x
    y0, y1 = min(ys) - pad_y, max(ys) + pad_y
    height = max(400, int(CANVAS_W * (y1 - y0) / (x1 - x0)))

    img = fetch_tile_background(x0, y0, x1, y1, CANVAS_W, height)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34)
    except OSError:
        font = ImageFont.load_default()

    def to_px(lat, lng):
        mx, my = _merc(lat, lng)
        return ((mx - x0) / (x1 - x0) * CANVAS_W,
                (my - y0) / (y1 - y0) * height)

    for i, hole in enumerate(holes):
        px = [to_px(lat, lng) for lat, lng in hole["points"]]
        draw.line(px, fill=(16, 24, 32), width=9, joint="curve")   # dark halo
        draw.line(px, fill=(255, 255, 255), width=4, joint="curve")
        mx, my = px[len(px) // 2]
        label = letter_label(i)
        draw.ellipse([mx - 26, my - 26, mx + 26, my + 26],
                     fill=(255, 214, 0), outline=(16, 24, 32), width=3)
        draw.text((mx, my), label, fill=(16, 24, 32), font=font, anchor="mm")
    return img


def fetch_tile_background(x0, y0, x1, y1, w, h) -> Image.Image:
    """Stitch Esri World Imagery tiles for the bbox; plain background on failure."""
    try:
        z = min(18, max(12, int(math.log2(1.0 / (x1 - x0))) + int(math.log2(w / 256))))
        n = 2 ** z
        tx0, tx1 = int(x0 * n), int(x1 * n)
        ty0, ty1 = int(y0 * n), int(y1 * n)
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 64:
            raise ValueError("too many tiles")
        mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
        with httpx.Client(timeout=10) as http:
            for ty in range(ty0, ty1 + 1):
                for tx in range(tx0, tx1 + 1):
                    r = http.get(TILE_URL.format(z=z, x=tx, y=ty))
                    r.raise_for_status()
                    mosaic.paste(Image.open(io.BytesIO(r.content)),
                                 ((tx - tx0) * 256, (ty - ty0) * 256))
        # crop mosaic to exact bbox, then resize to canvas
        px0 = (x0 * n - tx0) * 256
        py0 = (y0 * n - ty0) * 256
        px1 = (x1 * n - tx0) * 256
        py1 = (y1 * n - ty0) * 256
        return mosaic.crop((px0, py0, px1, py1)).resize((w, h))
    except Exception:
        return Image.new("RGB", (w, h), (34, 68, 40))  # fairway green


# ---------------------------------------------------------------------------
# Claude matching: lettered schematic vs official course map
# ---------------------------------------------------------------------------

def match_letters(schem_b64, map_b64, letters: list[str], course_name: str) -> dict:
    prompt = f"""You are given two images of the golf course "{course_name}":
1. FIRST image: hole centerlines from map data, drawn over satellite imagery.
   Each line is tagged with a LETTER in a yellow circle: {", ".join(letters)}.
2. SECOND image: the official course layout map with NUMBERED holes.

Task: assign the correct hole NUMBER to every LETTERED line by matching hole
shapes, lengths, orientations, and relative positions. The images may differ in
rotation and scale — establish orientation from distinctive features first
(clubhouse, water, doglegs, boundary roads), then propagate numbers.

Respond with ONLY this JSON (no other text, no markdown):
{{
  "success": true/false,
  "assignments": {{"A": 1, "B": 2, ...}},
  "unassigned": ["letters you could NOT confidently number"]
}}

Set "success" to false if the layout map does not depict this course or you
cannot establish orientation. Never guess — uncertain letters go in "unassigned"."""
    resp = mapper.client.messages.create(
        model=mapper.MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": [
            mapper.image_block(schem_b64, "image/jpeg"),
            mapper.image_block(map_b64, "image/jpeg"),
            {"type": "text", "text": prompt}]}],
    )
    return mapper.extract_json(mapper.text_of(resp))


def is_clean_assignment(result: dict, letters: list[str], total_holes: int) -> bool:
    if not result.get("success") or result.get("unassigned"):
        return False
    asg = result.get("assignments") or {}
    if sorted(asg.keys()) != sorted(letters):
        return False
    nums = list(asg.values())
    if len(set(nums)) != len(nums):
        return False
    if not all(isinstance(n, int) and 1 <= n <= EXPECTED_HOLES for n in nums):
        return False
    # If OSM has a full course, demand the full 1..18 set
    if total_holes >= EXPECTED_HOLES and sorted(nums) != list(range(1, EXPECTED_HOLES + 1)):
        return False
    return True


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def resolve_course_name(lat: float, lng: float) -> str | None:
    try:
        r = httpx.get("https://nominatim.openstreetmap.org/reverse",
                      params={"lat": lat, "lon": lng, "format": "json", "zoom": 15},
                      headers={"User-Agent": "GolfDaddy-hole-labeler"}, timeout=10)
        name = (r.json().get("name")
                or r.json().get("display_name", "").split(",")[0])
        return name or None
    except Exception:
        return None


def run_pipeline(job_id: str, lat: float, lng: float,
                 course_name: str | None, cache_key: str):
    try:
        holes = fetch_osm_holes(lat, lng)
        unlabeled = [h for h in holes if h["ref"] is None]
        if not unlabeled:
            _finish(job_id, cache_key, {"labels": {}, "note": "no unlabeled holes"})
            return

        course_name = course_name or resolve_course_name(lat, lng)
        if not course_name:
            _fail(job_id, "could not resolve course name; pass course_name explicitly")
            return

        letters = [letter_label(i) for i in range(len(unlabeled))]
        schematic = render_schematic(unlabeled)
        buf = io.BytesIO()
        schematic.save(buf, format="JPEG", quality=90)
        schem_b64 = base64.standard_b64encode(buf.getvalue()).decode()

        pages = mapper.find_candidate_pages(course_name)
        image_urls = mapper.scrape_image_urls(pages) if pages else []

        attempted, labels = 0, None
        with httpx.Client(follow_redirects=True, timeout=15,
                          headers={"User-Agent": "Mozilla/5.0"}) as http:
            for img_url in image_urls:
                if attempted >= mapper.MAX_CANDIDATE_MAPS:
                    break
                try:
                    map_b64, _ = mapper.load_image_b64(http.get(img_url).content)
                except Exception:
                    continue
                if not mapper.screen_candidate(map_b64, "image/jpeg", course_name):
                    continue
                attempted += 1
                try:
                    result = match_letters(schem_b64, map_b64, letters, course_name)
                except Exception:
                    continue
                if is_clean_assignment(result, letters, len(holes)):
                    asg = result["assignments"]
                    labels = {unlabeled[i]["key"]: asg[letters[i]]
                              for i in range(len(unlabeled))}
                    _finish(job_id, cache_key, {
                        "labels": labels,
                        "course_name": course_name,
                        "source_map_url": img_url,
                        "schematic_png_b64": schem_b64,  # for a verification UI
                    })
                    return

        _fail(job_id, "no candidate course map produced a clean assignment")
    except Exception as exc:
        _fail(job_id, str(exc))


def _finish(job_id, cache_key, result):
    with LOCK:
        JOBS[job_id] = {"status": "done", "result": result, "error": None}
    cache_put(cache_key, result)


def _fail(job_id, error):
    with LOCK:
        JOBS[job_id] = {"status": "failed", "result": None, "error": error}


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------

class LabelRequest(BaseModel):
    lat: float
    lng: float
    course_name: str | None = None


@app.post("/v1/osm-hole-labels")
def create_labels(req: LabelRequest):
    cache_key = f"{round(req.lat, 4)},{round(req.lng, 4)}"
    cached = cache_get(cache_key)
    if cached is not None:
        return {"status": "done", "result": cached, "cached": True}

    job_id = uuid.uuid4().hex
    with LOCK:
        JOBS[job_id] = {"status": "pending", "result": None, "error": None}
    threading.Thread(target=run_pipeline,
                     args=(job_id, req.lat, req.lng, req.course_name, cache_key),
                     daemon=True).start()
    return {"job_id": job_id, "status": "pending"}


@app.get("/v1/osm-hole-labels/jobs/{job_id}")
def get_job(job_id: str):
    with LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job_id")
    return job


@app.get("/healthz")
def healthz():
    return {"ok": True, "supabase_cache": bool(SUPABASE_URL and SUPABASE_KEY)}
