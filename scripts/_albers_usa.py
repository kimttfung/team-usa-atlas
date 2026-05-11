"""
Shared U.S. Albers Equal-Area Conic composite projection.

Used by:
  - scripts/build_us_states_map.py  (state polygons + city anchors)
  - scripts/build_hometown_geo.py   (athlete hometown bubbles)

Both scripts import from this module so the SVG state map and the bubble
overlay are guaranteed to use identical projections — no drift, no off-by-N
bubble placement.

Why this projection
-------------------
The Albers Equal-Area Conic is the long-standing standard for U.S. thematic
maps (USGS, the National Atlas, the Census Bureau, d3-geo's geoAlbersUsa).
It preserves area, which is the right tradeoff for choropleths (we don't
want California to look smaller than it is just because it's far from the
central meridian).

We use a three-region composite:
  - Lower-48 states: standard parallels 29.5°/45.5°, central meridian -96°.
  - Alaska:          standard parallels 55°/65°,    central meridian -154°.
  - Hawaii:          standard parallels 8°/18°,     central meridian -157°.

Each region is projected independently with pyproj/PROJ and then laid out
on the canvas: the lower-48 fills the upper portion of the viewBox, while
Alaska and Hawaii sit as small insets in the lower-left.

Sources used elsewhere in this module
-------------------------------------
- us-atlas v3 (states-10m.json) — public-domain TopoJSON repackaging of the
  U.S. Census Bureau Cartographic Boundary Files at 1:10,000,000 scale.
  https://github.com/topojson/us-atlas
- pyproj — Python interface to PROJ, the standard cartographic projections
  library (USGS / OSGeo).  https://pyproj4.github.io/pyproj/

The functions below have no hidden side effects and no random sampling:
re-running them against the same upstream sources produces identical output.
"""

import io
import json
import os
import zipfile

import requests
from pyproj import Transformer


# =========================
# 1. PUBLIC CONSTANTS
# =========================

# Output canvas dimensions. Kept stable across rebuilds because /assets/css/
# map.css and the bubble overlay in /assets/js/ui/map.js are sized against
# this viewBox.
VIEWBOX_W = 975
VIEWBOX_H = 610

# Pixel rectangles (x_min, y_min, x_max, y_max) where each region is laid
# out inside the viewBox. The lower-48 fills the upper portion of the
# canvas; AK and HI sit as small insets in the lower-left.
CONTINENTAL_BOX = (10,  10, 970, 540)
ALASKA_BOX      = (10, 410, 200, 595)
HAWAII_BOX      = (210, 510, 290, 595)

# PROJ strings for the three Albers Equal-Area Conic projections used in the
# composite. All three use the GRS80 ellipsoid (the same datum the U.S.
# Census Bureau publishes in). Standard parallels follow the conventions in:
#   J. P. Snyder, "Map Projections — A Working Manual" (USGS, 1987), p.103.
PROJ_CONTINENTAL = (
    "+proj=aea +lat_1=29.5 +lat_2=45.5 +lon_0=-96 +lat_0=37.5 +ellps=GRS80"
)
PROJ_ALASKA = (
    "+proj=aea +lat_1=55 +lat_2=65 +lon_0=-154 +lat_0=50 +ellps=GRS80"
)
PROJ_HAWAII = (
    "+proj=aea +lat_1=8 +lat_2=18 +lon_0=-157 +lat_0=13 +ellps=GRS80"
)

# US Census FIPS state codes → USPS two-letter postal codes. Includes the 50
# states + DC. Territories (PR, VI, GU, MP, AS) are intentionally excluded
# from the composite — none of the downstream views render territory data,
# and standard AlbersUsa-style composites omit them by convention.
FIPS_TO_USPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
    "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
    "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY",
}


# =========================
# 2. CACHE PATHS
# =========================

US_ATLAS_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json"
GEONAMES_URL = "https://download.geonames.org/export/dump/US.zip"

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(_THIS_DIR, ".cache")
ATLAS_CACHE = os.path.join(CACHE_DIR, "us-atlas-states-10m.json")
GEONAMES_CACHE = os.path.join(CACHE_DIR, "geonames_us_places.tsv")


# =========================
# 3. SOURCE FETCHERS
# =========================

def fetch_us_atlas():
    """
    Download (and cache) the us-atlas v3 states-10m TopoJSON document.
    Returns the parsed dict.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    if not os.path.exists(ATLAS_CACHE):
        print(f"[albers_usa] fetching us-atlas → {US_ATLAS_URL}")
        r = requests.get(US_ATLAS_URL, timeout=120)
        r.raise_for_status()
        with open(ATLAS_CACHE, "wb") as f:
            f.write(r.content)
        print(f"[albers_usa]   cached → {ATLAS_CACHE}")
    with open(ATLAS_CACHE, encoding="utf-8") as f:
        return json.load(f)


def fetch_geonames_places():
    """
    Download (and cache) the GeoNames US gazetteer, keeping only the
    populated-place rows (feature_class == 'P'). Returns a list of
    tab-split rows. The GeoNames schema is:
      0  geonameid          5  longitude       10 admin1_code (state)
      1  name               6  feature_class   14 population
      2  asciiname          7  feature_code
      3  alternatenames     8  country_code
      4  latitude           9  cc2
    Licence: CC BY 4.0 (attribution: GeoNames.org).
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    if not os.path.exists(GEONAMES_CACHE):
        print(f"[albers_usa] fetching GeoNames → {GEONAMES_URL}")
        resp = requests.get(GEONAMES_URL, timeout=180)
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            with z.open("US.txt") as src, open(GEONAMES_CACHE + ".tmp", "wb") as dst:
                for line in src:
                    fields = line.decode("utf-8").rstrip("\n").split("\t")
                    if len(fields) >= 8 and fields[6] == "P":
                        dst.write(line)
        os.replace(GEONAMES_CACHE + ".tmp", GEONAMES_CACHE)
        print(f"[albers_usa]   cached populated-places → {GEONAMES_CACHE}")
    with open(GEONAMES_CACHE, encoding="utf-8") as f:
        return [line.rstrip("\n").split("\t") for line in f]


# =========================
# 4. TOPOJSON DECODING
# =========================

def decode_arcs(topo):
    """
    Decode TopoJSON delta-encoded arcs into absolute (lng, lat) polylines.
    TopoJSON stores each arc as a chain of integer deltas; the
    transform.scale and transform.translate convert them back to lat/lng.
    """
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    out = []
    for arc in topo["arcs"]:
        pts = []
        x, y = 0, 0
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        out.append(pts)
    return out


def stitch_arcs(arc_indices, arcs):
    """
    Concatenate a sequence of arc references (negative index = reversed)
    into a single ring. Skips the duplicate join point between consecutive
    arcs.
    """
    ring = []
    for i, idx in enumerate(arc_indices):
        arc = arcs[idx] if idx >= 0 else list(reversed(arcs[~idx]))
        if i == 0:
            ring.extend(arc)
        else:
            ring.extend(arc[1:])
    return ring


def state_rings(state_obj, arcs):
    """
    Return the list of (lng, lat) polygon rings for a TopoJSON state object.
    Polygon → one ring per outer/inner; MultiPolygon → all rings flattened.
    """
    rings = []
    if state_obj["type"] == "Polygon":
        for arc_seq in state_obj["arcs"]:
            rings.append(stitch_arcs(arc_seq, arcs))
    elif state_obj["type"] == "MultiPolygon":
        for poly in state_obj["arcs"]:
            for arc_seq in poly:
                rings.append(stitch_arcs(arc_seq, arcs))
    else:
        raise ValueError(f"Unexpected geometry type: {state_obj['type']}")
    return rings


# =========================
# 5. PROJECTION + ROUTING
# =========================

# pyproj Transformers (lazy-instantiated on first use).
_T_CONT = None
_T_AK = None
_T_HI = None


def _t_cont():
    global _T_CONT
    if _T_CONT is None:
        _T_CONT = Transformer.from_crs("EPSG:4326", PROJ_CONTINENTAL, always_xy=True)
    return _T_CONT


def _t_ak():
    global _T_AK
    if _T_AK is None:
        _T_AK = Transformer.from_crs("EPSG:4326", PROJ_ALASKA, always_xy=True)
    return _T_AK


def _t_hi():
    global _T_HI
    if _T_HI is None:
        _T_HI = Transformer.from_crs("EPSG:4326", PROJ_HAWAII, always_xy=True)
    return _T_HI


def region_for_state(usps):
    """Static state→region routing by USPS state code."""
    if usps == "AK":
        return "AK"
    if usps == "HI":
        return "HI"
    return "CONT"


def region_for_point(lng, lat):
    """
    Geographic routing for individual points (used when the caller doesn't
    know the state up front, e.g. raw lat/lng from GeoNames). Returns
    'CONT', 'AK', 'HI', or None for points outside all three insets
    (territories, etc.).
    """
    if 18.0 <= lat <= 23.0 and -161.0 <= lng <= -154.0:
        return "HI"
    # Alaska bounding box; Aleutian Islands wrap across the antimeridian
    # (longitudes near +170° → routed to AK as well).
    if (lat >= 51.0 and lng <= -129.0) or (lat >= 18.0 and lng >= 170.0):
        return "AK"
    if -125.0 <= lng <= -66.0 and 24.0 <= lat <= 50.0:
        return "CONT"
    return None


def project_raw(lng, lat, region):
    """
    Project a single point into raw projection coordinates (meters) for its
    region. The result is unscaled — call build_pixel_transforms() to map
    raw coords into the SVG viewBox.
    """
    if region == "CONT":
        return _t_cont().transform(lng, lat)
    if region == "AK":
        return _t_ak().transform(lng, lat)
    if region == "HI":
        return _t_hi().transform(lng, lat)
    raise ValueError(f"Unknown region: {region}")


# =========================
# 6. PIXEL LAYOUT
# =========================

def fit_to_box(raw_points, target_box):
    """
    Given a cloud of raw projection points and a target pixel rectangle,
    compute (scale, offset_x, offset_y) so that the bounding box of the
    points centers inside the target box, preserving aspect ratio. Raw
    +y = north is flipped to SVG +y = south.

    Returns a dict {scale, offset_x, offset_y, transform(x, y) → (px, py)}.
    """
    xs = [p[0] for p in raw_points]
    ys = [p[1] for p in raw_points]
    raw_xmin, raw_xmax = min(xs), max(xs)
    raw_ymin, raw_ymax = min(ys), max(ys)
    raw_w = raw_xmax - raw_xmin
    raw_h = raw_ymax - raw_ymin

    bx0, by0, bx1, by1 = target_box
    box_w = bx1 - bx0
    box_h = by1 - by0
    scale = min(box_w / raw_w, box_h / raw_h)

    # Center within the target box.
    px_w = raw_w * scale
    px_h = raw_h * scale
    offset_x = bx0 + (box_w - px_w) / 2.0 - raw_xmin * scale
    offset_y = by0 + (box_h - px_h) / 2.0 + raw_ymax * scale

    def transform(x, y):
        return (x * scale + offset_x, -y * scale + offset_y)

    return {
        "scale":     scale,
        "offset_x":  offset_x,
        "offset_y":  offset_y,
        "transform": transform,
    }


# =========================
# 7. CANONICAL PIPELINE
# =========================

def load_state_geometries():
    """
    Fetch us-atlas, decode arcs, project every state's polygon vertices
    into raw projection meters, and tag each with its region. Returns a
    list of dicts:
        {usps, name, region, raw_rings}
    where raw_rings is a list of rings, each a list of (raw_x, raw_y).
    """
    topo = fetch_us_atlas()
    arcs = decode_arcs(topo)
    out = []
    for sobj in topo["objects"]["states"]["geometries"]:
        usps = FIPS_TO_USPS.get(sobj["id"])
        if not usps:
            continue  # territory — excluded from the composite
        region = region_for_state(usps)
        raw_rings = []
        for ring in state_rings(sobj, arcs):
            raw_rings.append([project_raw(lng, lat, region) for lng, lat in ring])
        out.append({
            "usps":      usps,
            "name":      sobj["properties"]["name"],
            "region":    region,
            "raw_rings": raw_rings,
        })
    return out


def build_pixel_transforms(state_geometries):
    """
    Compute the per-region pixel transforms used by the composite. The
    bounding box for each region is derived ONLY from the state polygon
    vertices (not from cities or hometowns) so the transforms are stable
    across runs and across consumers — the bubble layer stays aligned with
    the state boundaries no matter what hometowns are passed in.

    Returns a dict {region: fit_dict} where each fit_dict has
    {scale, offset_x, offset_y, transform}.
    """
    cont_pts, ak_pts, hi_pts = [], [], []
    for s in state_geometries:
        bucket = (cont_pts if s["region"] == "CONT"
                  else ak_pts if s["region"] == "AK" else hi_pts)
        for ring in s["raw_rings"]:
            bucket.extend(ring)
    return {
        "CONT": fit_to_box(cont_pts, CONTINENTAL_BOX),
        "AK":   fit_to_box(ak_pts,   ALASKA_BOX) if ak_pts else None,
        "HI":   fit_to_box(hi_pts,   HAWAII_BOX) if hi_pts else None,
    }


def project_latlng_to_pixels(transforms, lng, lat):
    """
    Project a (lng, lat) WGS84 point into the composite's pixel space.
    Returns (px, py) or None if the point lies outside the supported
    regions (e.g. U.S. territories).
    """
    region = region_for_point(lng, lat)
    if region is None or transforms.get(region) is None:
        return None
    raw_x, raw_y = project_raw(lng, lat, region)
    return transforms[region]["transform"](raw_x, raw_y)
