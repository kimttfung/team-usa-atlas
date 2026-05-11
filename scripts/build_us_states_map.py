"""
Build data/us-states-map.json — the SVG state map for the Atlas.

What this produces
------------------
A single JSON document of shape:

    {
      "viewBox": "0 0 975 610",
      "source": { ... attribution + URLs ... },
      "states": {
        "CA": { "name": "California", "d": "M…Z", "c": [cx, cy] },
        ...   (50 states + DC)
      },
      "cities": [
        { "city": "Los Angeles", "state": "CA", "x": 87, "y": 363 },
        ...   (one per state, plus the country's largest cities)
      ]
    }

The file feeds the choropleth renderer in /assets/js/ui/map.js. State paths
and city anchors are projected through the same Albers Equal-Area Conic
composite as data/hometown_geo.json (see scripts/_albers_usa.py and
scripts/build_hometown_geo.py) so every layer of the map shares one
coordinate system.

Public sources used
-------------------
1. State boundaries — us-atlas v3 (states-10m.json)
   https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json
   Mike Bostock's public-domain TopoJSON repackaging of the U.S. Census
   Bureau Cartographic Boundary Files at 1:10,000,000 scale. The Census
   source is in the public domain; us-atlas is published under ISC.

2. City anchors — GeoNames US gazetteer
   https://download.geonames.org/export/dump/US.zip
   CC BY 4.0 listing of every populated place in the United States with
   latitude, longitude, population, and a feature code (PPLC = country
   capital, PPLA = state capital, PPL = generic populated place). We
   select anchors purely by population — no hand-curated city list.

3. Projection — Albers Equal-Area Conic (USGS standard parallels)
   The math is delegated to PROJ via the pyproj Python library.
   https://pyproj4.github.io/pyproj/

Reproducibility
---------------
- Cached downloads live in scripts/.cache/. Delete that directory to force
  a fresh download.
- Every projection parameter is a documented constant in scripts/_albers_usa.py.
- No random sampling, no manual tweaking, no per-state fudge factors.
- Re-running this script against the same upstream sources produces a
  byte-identical us-states-map.json.

Usage
-----
    pip install --user requests pyproj
    python3 scripts/build_us_states_map.py             # write data/us-states-map.json
    python3 scripts/build_us_states_map.py --dry-run   # preview only
"""

import argparse
import json
import os
import sys

# Shared projection module — the canonical source of every constant and
# transformation used here. See scripts/_albers_usa.py for full docs.
import _albers_usa as proj


# =========================
# 1. CONFIG
# =========================

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR    = os.path.join(PROJECT_DIR, "data")
OUT_FILE    = os.path.join(DATA_DIR, "us-states-map.json")

# Total number of city anchors to emit. Step 1 of selection guarantees one
# per state (51 records); the remainder is filled with the country's
# most-populous cities to give the map enough labelled anchor points.
TARGET_ANCHOR_COUNT = 80


# =========================
# 2. SVG PATH ASSEMBLY
# =========================

def ring_to_subpath(ring):
    """
    Convert a list of (x, y) pixel points into one SVG subpath:
      M x0,y0 L x1,y1 ... Z
    Coordinates are rounded to integers (the source data is already
    simplified at 1:10M, so sub-pixel precision adds no information and
    bloats the output).
    """
    if len(ring) < 2:
        return ""
    parts = []
    px, py = round(ring[0][0]), round(ring[0][1])
    parts.append(f"M{px},{py}")
    last_px, last_py = px, py
    for x, y in ring[1:]:
        rx, ry = round(x), round(y)
        if rx == last_px and ry == last_py:
            continue
        parts.append(f"L{rx},{ry}")
        last_px, last_py = rx, ry
    parts.append("Z")
    return "".join(parts)


def ring_area(ring):
    """Unsigned shoelace area of a ring (in pixel² units)."""
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def polygon_centroid(ring):
    """Geometric centroid of a simple polygon ring, rounded to (x, y)."""
    cx = cy = 0.0
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    a *= 0.5
    if abs(a) < 1e-9:
        # Degenerate ring — fall back to the average of its vertices.
        cx = sum(p[0] for p in ring) / n
        cy = sum(p[1] for p in ring) / n
        return (round(cx), round(cy))
    cx /= 6.0 * a
    cy /= 6.0 * a
    return (round(cx), round(cy))


def visual_centroid(rings):
    """
    Approximate visual centroid of a multi-ring polygon: take the centroid
    of the largest ring (good enough for label and anchor placement).
    """
    largest = max(rings, key=ring_area)
    return polygon_centroid(largest)


# =========================
# 3. CITY ANCHOR SELECTION
# =========================

def select_city_anchors(geonames_rows, target_count):
    """
    Choose city anchors using only population data:
      1. Every state contributes its single most-populous PPL/PPLA/PPLC
         entry — guarantees small states are represented.
      2. The remaining slots are filled with the country's most-populous
         cities (largest first), skipping any already in step 1.
    Returns a list of {city, state, lat, lng, population} dicts sorted
    largest-first (with city-name tiebreak for determinism).
    """
    valid_codes = set(proj.FIPS_TO_USPS.values())
    feature_codes = ("PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLC")

    best = {}
    for row in geonames_rows:
        if len(row) < 15 or row[7] not in feature_codes:
            continue
        state = row[10]
        if state not in valid_codes:
            continue
        try:
            pop = int(row[14] or 0)
            lat = float(row[4])
            lng = float(row[5])
        except ValueError:
            continue
        name = row[1]
        key = (name, state)
        if key not in best or pop > best[key]["population"]:
            best[key] = {"city": name, "state": state, "lat": lat, "lng": lng, "population": pop}

    all_cities = sorted(best.values(), key=lambda c: -c["population"])

    chosen = {}
    seen_states = set()
    # Step 1: most-populous city per state.
    for c in all_cities:
        if c["state"] not in seen_states:
            chosen[(c["city"], c["state"])] = c
            seen_states.add(c["state"])

    # Step 2: top-up with overall most-populous cities.
    for c in all_cities:
        if len(chosen) >= target_count:
            break
        chosen.setdefault((c["city"], c["state"]), c)

    out = list(chosen.values())
    out.sort(key=lambda c: (-c["population"], c["city"]))
    return out


# =========================
# 4. MAIN PIPELINE
# =========================

def main():
    parser = argparse.ArgumentParser(description="Rebuild data/us-states-map.json")
    parser.add_argument("--dry-run", action="store_true", help="don't write the output file")
    args = parser.parse_args()

    # ---- LOAD --------------------------------------------------------------
    state_geoms = proj.load_state_geometries()
    print(f"Loaded {len(state_geoms)} states (50 + DC; territories excluded)")

    geonames = proj.fetch_geonames_places()
    print(f"Loaded {len(geonames):,} GeoNames populated-place rows")

    # ---- COMPOSITE TRANSFORMS ---------------------------------------------
    # Computed from state polygon vertices only — guarantees the bubble
    # overlay (built later by build_hometown_geo.py from the SAME function)
    # uses the identical layout.
    transforms = proj.build_pixel_transforms(state_geoms)

    if transforms["CONT"] is None:
        sys.exit("FATAL: no continental points projected — check us-atlas decoding")

    def to_pixels(region, x, y):
        return transforms[region]["transform"](x, y)

    # ---- ASSEMBLE STATE PATHS ---------------------------------------------
    states_out = {}
    for s in state_geoms:
        pixel_rings = [
            [to_pixels(s["region"], rx, ry) for rx, ry in ring]
            for ring in s["raw_rings"]
        ]
        d = "".join(ring_to_subpath(r) for r in pixel_rings)
        cx, cy = visual_centroid(pixel_rings)
        states_out[s["usps"]] = {"name": s["name"], "d": d, "c": [cx, cy]}

    # ---- PICK + PROJECT CITY ANCHORS --------------------------------------
    cities = select_city_anchors(geonames, TARGET_ANCHOR_COUNT)
    cities_out = []
    for c in cities:
        xy = proj.project_latlng_to_pixels(transforms, c["lng"], c["lat"])
        if xy is None:
            continue
        cities_out.append({
            "city":  c["city"],
            "state": c["state"],
            "x":     int(round(xy[0])),
            "y":     int(round(xy[1])),
        })
    print(f"Selected {len(cities_out)} city anchors (target {TARGET_ANCHOR_COUNT})")

    # ---- ASSEMBLE OUTPUT --------------------------------------------------
    states_sorted = {k: states_out[k] for k in sorted(states_out)}
    cities_out.sort(key=lambda c: (c["state"], c["city"]))

    out = {
        "viewBox": f"0 0 {proj.VIEWBOX_W} {proj.VIEWBOX_H}",
        "source": {
            "boundaries":  "us-atlas v3 (states-10m.json) — public-domain TopoJSON repackaging of US Census Cartographic Boundary Files (1:10M)",
            "boundaries_url": proj.US_ATLAS_URL,
            "cities":      "GeoNames US gazetteer (CC BY 4.0)",
            "cities_url":  proj.GEONAMES_URL,
            "projection":  "Albers Equal-Area Conic (USGS standard parallels) via pyproj/PROJ; composite layout with Alaska + Hawaii insets",
            "build":       "scripts/build_us_states_map.py (uses scripts/_albers_usa.py)",
        },
        "states": states_sorted,
        "cities": cities_out,
    }

    print(f"Result: {len(states_sorted)} states, {len(cities_out)} city anchors")

    if args.dry_run:
        print(f"[dry-run] would write {OUT_FILE}")
        return

    with open(OUT_FILE, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_FILE) / 1024
    print(f"Wrote {OUT_FILE} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
