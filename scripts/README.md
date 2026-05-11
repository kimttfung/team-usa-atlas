# `scripts/` — data build pipelines

Every JSON file in `/data/` is produced by one of the Python scripts in
this folder. Together they form the project's reproducible data pipeline:
delete `/data/`, install the dependencies, run the scripts, and you get
back exactly the same files.

| Output file | Script | Public source(s) |
|---|---|---|
| `data/athletes_clean.json`              | `clean_teamusa.py` | Team USA athlete roster pages |
| `data/athlete_sports.json`              | `clean_teamusa.py` | Team USA athlete roster pages |
| `data/athlete_participation_clean.json` | `clean_teamusa.py` | Team USA athlete roster pages |
| `data/state_summary.json`               | `clean_teamusa.py` | Team USA athlete roster pages |
| `data/state_sport_summary.json`         | `clean_teamusa.py` | Team USA athlete roster pages |
| `data/hometown_summary.json`            | `clean_teamusa.py` | Team USA athlete roster pages |
| `data/climate_state_summary.json`       | `clean_noaa.py`    | NOAA nClimDiv 1991–2020 normals |
| `data/us-states-map.json`               | `build_us_states_map.py` | us-atlas v3 (US Census, public domain) + GeoNames (CC BY 4.0) |
| `data/hometown_geo.json`                | `build_hometown_geo.py`  | GeoNames (CC BY 4.0) |

## Setup

```sh
pip install --user requests pandas pyproj
```

| Package    | Used by | Purpose |
|---|---|---|
| `requests` | all     | HTTP downloads |
| `pandas`   | `clean_teamusa.py`, `clean_noaa.py` | data wrangling |
| `pyproj`   | `build_us_states_map.py`, `build_hometown_geo.py` | Albers Equal-Area Conic projection |

## Files

- **`clean_noaa.py`** — fetches NOAA's nClimDiv state-level temperature and
  precipitation normals (1991–2020) and reshapes them into the
  per-state monthly table consumed by the climate views.
- **`clean_teamusa.py`** — scrapes the public Team USA roster pages
  (Olympic + Paralympic, Summer + Winter), normalizes athlete records,
  and produces the seven athlete/state summary JSONs.
- **`_albers_usa.py`** *(internal helper)* — shared module with the
  Albers Equal-Area Conic composite projection used by both map-build
  scripts. Houses every projection constant, the TopoJSON decoder, the
  region-routing logic, and the canonical pipeline functions
  (`load_state_geometries`, `build_pixel_transforms`,
  `project_latlng_to_pixels`).
- **`build_us_states_map.py`** — fetches the us-atlas v3 TopoJSON,
  projects every state through `_albers_usa`, picks 80 city anchors from
  GeoNames purely by population, and writes `data/us-states-map.json`.
  Pass `--dry-run` to preview without writing.
- **`build_hometown_geo.py`** — fetches GeoNames, geocodes every entry in
  `data/hometown_summary.json`, projects through the **same**
  `_albers_usa` pipeline, and writes `data/hometown_geo.json`. The fact
  that both map-build scripts use the same projection module is what
  guarantees the bubble overlay aligns with the state polygons to
  sub-pixel precision.

## How the data flows

```
NOAA nClimDiv ──► clean_noaa.py ────────────────► data/climate_state_summary.json

                                          ┌────► data/athletes_clean.json
                                          ├────► data/athlete_sports.json
Team USA ────► clean_teamusa.py ───────┼────► data/athlete_participation_clean.json
                                          ├────► data/state_summary.json
                                          ├────► data/state_sport_summary.json
                                          ├────► data/hometown_summary.json   ──┐
                                          └────► data/climate_state_summary.json (joined)
                                                                                │
us-atlas v3 ──┐                                                                 │
              ├──► build_us_states_map.py ───► data/us-states-map.json          │
GeoNames    ──┤                                                                 │
              └──► build_hometown_geo.py  ───► data/hometown_geo.json  ◄────────┘
```

## Reproducibility

- Every script caches downloads under `scripts/.cache/`. Delete that
  directory to force a fresh fetch.
- All scripts are deterministic. Re-running against the same upstream
  sources produces byte-identical output.
- Each script writes only to its own output file in `/data/`. The other
  six original JSON files are never modified.

## Sources & licences

| Source | URL | Licence |
|---|---|---|
| Team USA athlete rosters | <https://www.teamusa.com/> | Publicly accessible web pages |
| NOAA nClimDiv normals       | <https://www.ncei.noaa.gov/pub/data/cirs/climdiv/> | Public domain (U.S. federal data) |
| us-atlas v3                 | <https://github.com/topojson/us-atlas> | ISC; underlying Census data is public domain |
| GeoNames US gazetteer       | <https://download.geonames.org/export/dump/US.zip> | CC BY 4.0 |
| PROJ / pyproj               | <https://proj.org/> · <https://pyproj4.github.io/pyproj/> | MIT |

All four pipelines (the Team USA athlete-roster pipeline `clean_teamusa.py`,
the NOAA climate pipeline `clean_noaa.py`, and the geographic build scripts
`build_us_states_map.py` and `build_hometown_geo.py`) write idempotently into
`/data/`, so re-runs simply overwrite the previous output.
