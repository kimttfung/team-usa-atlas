"""
Build data/hometown_geo.json — pixel coordinates for every athlete hometown
in data/hometown_summary.json, projected through the same Albers Equal-Area
Conic composite as the SVG state map.

What this produces
------------------
A JSON array of objects, one per matched hometown:

    [
      {
        "hometown_key":   "san_diego_ca",
        "hometown_city":  "San Diego",
        "hometown_state": "CA",
        "lat":  32.71533,
        "lng": -117.15726,
        "x":   100,
        "y":   397
      },
      ...
    ]

The (x, y) values live in the same coordinate space as data/us-states-map.json
because both files are projected through scripts/_albers_usa.py — the
hometown bubbles overlay the state map without any post-hoc alignment.

Public sources used
-------------------
1. GeoNames US gazetteer — https://download.geonames.org/export/dump/US.zip
   CC BY 4.0 listing of every populated place in the United States with
   latitude, longitude, population, and a feature code (capital, county
   seat, etc.). This is our source of truth for city coordinates.

2. data/hometown_summary.json (already produced by scripts/clean_teamusa.py)
   The list of hometowns whose coordinates we need.

3. Projection — Albers Equal-Area Conic via pyproj
   See scripts/_albers_usa.py for the full math + source citations.

Reproducibility
---------------
- Cached downloads live in scripts/.cache/ (shared with build_us_states_map.py).
  Delete that directory to force a fresh download.
- This script has no dependency on data/us-states-map.json — it computes
  the projection transforms from scratch via _albers_usa.load_state_geometries()
  and _albers_usa.build_pixel_transforms(). That guarantees the bubbles
  align with the state map regardless of which is rebuilt first.
- A small alias table (EQUIVALENCE_ALIASES) reconciles roster spellings
  (typos, renamings, NYC borough names) with GeoNames' canonical names.
  Each alias is documented inline.

Usage
-----
    pip install --user requests pyproj
    python3 scripts/build_hometown_geo.py
"""

import json
import os
import re

# Shared projection module — see scripts/_albers_usa.py.
import _albers_usa as proj


# =========================
# 1. CONFIG
# =========================

SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR   = os.path.dirname(SCRIPT_DIR)
DATA_DIR      = os.path.join(PROJECT_DIR, "data")
HOMETOWN_FILE = os.path.join(DATA_DIR, "hometown_summary.json")
OUT_FILE      = os.path.join(DATA_DIR, "hometown_geo.json")

# Feature-code preference for picking the "best" GeoNames row when multiple
# settlements share a name + state. PPLC = country capital, PPLA = state
# capital, PPLA2 = county seat, PPL = generic populated place, PPLX =
# section of a populated place (lowest priority).
FEATURE_PREFERENCE = {
    "PPLC":  6,
    "PPLA":  5,
    "PPLA2": 4,
    "PPLA3": 3,
    "PPLA4": 2,
    "PPL":   1,
    "PPLX":  0,
}

# Reconcile roster spellings with GeoNames' canonical names. Each alias is
# documented so reviewers can audit the methodology.
EQUIVALENCE_ALIASES = {
    # NYC borough names → GeoNames' "New York City" record.
    ("new york", "NY"):       ("new york city", "NY"),
    # The Bronx is listed with the leading article in GeoNames.
    ("bronx", "NY"):          ("the bronx", "NY"),
    # Common typos found in the Team USA roster.
    ("milipitas", "CA"):      ("milpitas", "CA"),
    ("pheonix", "AZ"):        ("phoenix", "AZ"),
    # Resort renamed in 2021; GeoNames still indexes the old USGS name.
    ("palisades tahoe", "CA"): ("olympic valley", "CA"),
    # "Jackson Hole" is the colloquial name for the area around Jackson, WY.
    ("jackson hole", "WY"):   ("jackson", "WY"),
}


# =========================
# 2. NORMALIZATION + LOOKUP
# =========================

def normalize_city_state(city, state):
    """
    Normalize a (city, state) pair into a comparison key. Lowercases, strips
    punctuation, expands "St." → "Saint", and special-cases "Washington,
    D.C." (which appears in the roster with state code "WA").
    """
    c = (city or "").strip().lower().replace(".", "").replace("'", "").replace(",", "")
    c = re.sub(r"\s+", " ", c).strip()
    c = re.sub(r"^st (?=\w)", "saint ", c)
    s = (state or "").strip().upper()
    if "washington" in c and ("dc" in c.replace(" ", "") or (s == "WA" and "d c" in c)):
        return ("washington", "DC")
    return (c, s)


def build_geo_lookup(geonames_rows):
    """
    Index GeoNames populated places by (normalized city, state code). When
    multiple rows share a key, prefer higher feature_code preference, then
    larger population.
    """
    lookup = {}
    for row in geonames_rows:
        if len(row) < 15:
            continue
        try:
            pop = int(row[14] or 0)
            lat = float(row[4])
            lng = float(row[5])
        except ValueError:
            continue
        state = row[10]
        if not state or len(state) != 2:
            continue
        score = (FEATURE_PREFERENCE.get(row[7], 0), pop)
        # Index under both the official name and the asciified name so
        # accented variants (e.g. "Cañon City" vs "Canon City") resolve
        # to the same entry.
        for nm in (row[1], row[2]):
            if not nm:
                continue
            key = normalize_city_state(nm, state)
            existing = lookup.get(key)
            if existing is None or score > existing[2:]:
                lookup[key] = (lat, lng, score[0], score[1])
    return lookup


def lookup_latlng(geo_lookup, city, state):
    """
    Resolve a hometown to (lat, lng) via:
      1. direct (city, state) match
      2. EQUIVALENCE_ALIASES override
      3. "Mc"-prefix fallback (GeoNames separates "Mc" surnames as "Mc Allen",
         "Mc Lean", etc.)
    Returns None if no match — those hometowns are silently dropped from
    the bubble overlay (they would never appear in any plausible top-10
    list anyway).
    """
    key = normalize_city_state(city, state)
    if key in geo_lookup:
        return geo_lookup[key][:2]
    if key in EQUIVALENCE_ALIASES:
        alias = EQUIVALENCE_ALIASES[key]
        if alias in geo_lookup:
            return geo_lookup[alias][:2]
    if key[0].startswith("mc") and len(key[0]) > 2:
        alt = ("mc " + key[0][2:], key[1])
        if alt in geo_lookup:
            return geo_lookup[alt][:2]
    return None


# =========================
# 3. MAIN PIPELINE
# =========================

def main():
    print("Loading source files...")
    with open(HOMETOWN_FILE) as f:
        hometowns = json.load(f)
    print(f"  hometowns: {len(hometowns):,}")

    geonames = proj.fetch_geonames_places()
    print(f"  GeoNames populated-place rows: {len(geonames):,}")

    geo_lookup = build_geo_lookup(geonames)
    print(f"  unique (city, state) keys: {len(geo_lookup):,}")

    print("Computing composite Albers projection transforms...")
    state_geoms = proj.load_state_geometries()
    transforms = proj.build_pixel_transforms(state_geoms)

    print("Geocoding hometowns...")
    matched = 0
    skipped_offmap = 0
    out = []
    for h in hometowns:
        ll = lookup_latlng(geo_lookup, h["hometown_city"], h["hometown_state"])
        if not ll:
            continue
        matched += 1
        lat, lng = ll
        xy = proj.project_latlng_to_pixels(transforms, lng, lat)
        if xy is None:
            # Outside CONT/AK/HI — typically a U.S. territory hometown.
            skipped_offmap += 1
            continue
        out.append({
            "hometown_key":   h["hometown_key"],
            "hometown_city":  h["hometown_city"],
            "hometown_state": h["hometown_state"],
            "lat":            round(lat, 5),
            "lng":            round(lng, 5),
            "x":              round(xy[0], 1),
            "y":              round(xy[1], 1),
        })

    out.sort(key=lambda r: r["hometown_key"])

    print()
    print(f"Results:")
    print(f"  hometowns geocoded:   {matched}/{len(hometowns)}  ({matched/len(hometowns)*100:.1f}%)")
    print(f"  skipped (off-map):    {skipped_offmap}")
    print(f"  written to file:      {len(out)}")

    with open(OUT_FILE, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_FILE) / 1024
    print(f"\nWrote {OUT_FILE} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
