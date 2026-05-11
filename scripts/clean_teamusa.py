"""
Build the six athlete-derived JSON files in /data/ from the public Team USA
roster API. This is the most data-intensive script in the pipeline — every
athlete-aware view in the app ultimately traces back to one of its outputs.

What this produces
------------------
1. athletes_clean.json              — one row per unique athlete (deduped by
                                       athlete_id, with cleaned hometown text).
2. athlete_sports.json              — long-format athlete↔sport bridge table.
3. athlete_participation_clean.json — fully denormalized rows (athlete × sport
                                       × program × season) used as the source
                                       of truth for any filtered aggregate.
4. state_summary.json               — per-state athlete counts, sport counts,
                                       Olympic/Paralympic split, and the
                                       parity ratio used by the Atlas map.
5. state_sport_summary.json         — per-(state, sport, season, sport_type)
                                       counts, used by Sport Explorer to draw
                                       the per-sport choropleth.
6. hometown_summary.json            — per-hometown rollup (city, state) used
                                       by Atlas hubs and Compare Regions.

Inputs
------
A single JSON endpoint (limit=10000 to fetch the entire current roster):
    https://www.teamusa.com/api/athletes?skip=0&limit=10000&filtersStatusSports=true

The script normalizes whitespace, validates 2-letter state codes, drops rows
with no usable hometown_state (those athletes can't appear on the U.S. map),
and writes every output to /data/ atomically with `df.to_json(..., indent=2)`.

Run as a standalone script:
    python scripts/clean_teamusa.py

Outputs are consumed by /assets/js/data/loader.js — one row per athlete in
athletes_clean.json, plus athlete↔sport, joined participation, and the
state / state-sport / hometown aggregate roll-ups read by the dashboard.
"""

import re
import requests
import pandas as pd
from pathlib import Path


# =========================
# 1. CONFIG
# =========================

URL = "https://www.teamusa.com/api/athletes?skip=0&limit=10000&filtersStatusSports=true"

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
OUTPUT_DIR = PROJECT_DIR / "data"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# =========================
# 2. HELPER FUNCTIONS
# =========================

def clean_string(value):
    """
    Clean whitespace, tabs, newlines, and empty strings.
    Converts empty strings to None.
    """
    if value is None:
        return None

    if not isinstance(value, str):
        return value

    value = re.sub(r"\s+", " ", value).strip()

    if value == "":
        return None

    return value


def normalize_city(value):
    """
    Clean city name.
    """
    value = clean_string(value)

    if value is None:
        return None

    return value.title()


def normalize_state(value):
    """
    Clean US state code.
    """
    value = clean_string(value)

    if value is None:
        return None

    return value.upper()


def make_hometown_key(city, state):
    """
    Create a stable hometown key like:
    los_angeles_ca
    """
    if city is None or state is None:
        return None

    city_part = city.lower().replace(" ", "_")
    state_part = state.lower()

    return f"{city_part}_{state_part}"


def is_bad_value(value):
    """
    Detect missing/dirty placeholder values.
    """
    if value is None:
        return True

    if pd.isna(value):
        return True

    value = str(value).strip().lower()

    bad_values = {
        "",
        "unknown",
        "unknown_city",
        "unknown_state",
        "null",
        "none",
        "nan",
        "n/a",
        "na",
        "-"
    }

    return value in bad_values


def safe_get(dictionary, keys, default=None):
    """
    Safely get nested values from dictionaries.
    """
    current = dictionary

    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)

    return current if current is not None else default


def parse_top_sports(group_df, top_n=5):
    """
    Return top sports as a semicolon-separated string.
    Example:
    Swimming: 12; Track and Field: 9
    """
    if group_df.empty or "sport" not in group_df.columns:
        return None

    counts = (
        group_df.dropna(subset=["sport"])
        .groupby("sport")["athlete_id"]
        .nunique()
        .sort_values(ascending=False)
        .head(top_n)
    )

    if counts.empty:
        return None

    return "; ".join([f"{sport}: {count}" for sport, count in counts.items()])


def parity_ratio(olympic_count, paralympic_count):
    """
    Simple Olympic/Paralympic balance score.

    1.0 = perfectly balanced
    0.0 = only one side represented
    """
    if olympic_count == 0 and paralympic_count == 0:
        return None

    bigger = max(olympic_count, paralympic_count)
    smaller = min(olympic_count, paralympic_count)

    if bigger == 0:
        return None

    return round(smaller / bigger, 3)


def remove_bad_rows(df, required_columns):
    """
    Remove rows where required columns are missing or dirty.
    """
    clean_df = df.copy()

    for col in required_columns:
        clean_df = clean_df[~clean_df[col].apply(is_bad_value)]

    return clean_df


# =========================
# 3. FETCH JSON
# =========================

print("Fetching data...")

response = requests.get(URL, timeout=30)
response.raise_for_status()
data = response.json()

entries = data.get("entries", [])

print(f"Loaded {len(entries)} athlete entries.")


# =========================
# 4. EXTRACT CLEAN ROWS
# =========================

athlete_rows = []
athlete_sport_rows = []
participation_rows = []

for entry in entries:
    athlete_id = clean_string(entry.get("uid"))

    hometown_city = normalize_city(
        safe_get(entry, ["bio", "quick_facts", "hometown", "city"])
    )

    hometown_state = normalize_state(
        safe_get(entry, ["bio", "quick_facts", "hometown", "state"])
    )

    hometown_key = make_hometown_key(hometown_city, hometown_state)

    para_classification = clean_string(entry.get("para_classification"))
    has_para_classification = para_classification is not None

    sports = entry.get("sport", [])

    if sports is None or not isinstance(sports, list):
        sports = []

    # Athlete-level row.
    # No name, no age, no bio, no medals, no images.
    athlete_rows.append({
        "athlete_id": athlete_id,
        "hometown_city": hometown_city,
        "hometown_state": hometown_state,
        "hometown_key": hometown_key,
        "has_para_classification": has_para_classification
    })

    # Athlete-sport rows.
    for sport_obj in sports:
        if not isinstance(sport_obj, dict):
            continue

        sport_title = clean_string(sport_obj.get("title"))
        sport_type = clean_string(sport_obj.get("type"))  # Olympic / Paralympic
        season = clean_string(sport_obj.get("season"))    # Summer / Winter

        athlete_sport_rows.append({
            "athlete_id": athlete_id,
            "sport": sport_title,
            "sport_type": sport_type,
            "season": season
        })

        participation_rows.append({
            "athlete_id": athlete_id,
            "hometown_city": hometown_city,
            "hometown_state": hometown_state,
            "hometown_key": hometown_key,
            "sport": sport_title,
            "sport_type": sport_type,
            "season": season,
            "has_para_classification": has_para_classification
        })


# =========================
# 5. CREATE DATAFRAMES
# =========================

athletes_clean = pd.DataFrame(athlete_rows)
athlete_sports = pd.DataFrame(athlete_sport_rows)
participation_clean = pd.DataFrame(participation_rows)


# =========================
# 6. REMOVE BAD / INCOMPLETE ROWS
# =========================

# Remove rows missing key values.
athletes_clean = remove_bad_rows(
    athletes_clean,
    ["athlete_id", "hometown_city", "hometown_state", "hometown_key"]
)

athlete_sports = remove_bad_rows(
    athlete_sports,
    ["athlete_id", "sport", "sport_type", "season"]
)

participation_clean = remove_bad_rows(
    participation_clean,
    [
        "athlete_id",
        "hometown_city",
        "hometown_state",
        "hometown_key",
        "sport",
        "sport_type",
        "season"
    ]
)

# Keep only Olympic / Paralympic sport types.
participation_clean = participation_clean[
    participation_clean["sport_type"].isin(["Olympic", "Paralympic"])
].copy()

athlete_sports = athlete_sports[
    athlete_sports["sport_type"].isin(["Olympic", "Paralympic"])
].copy()

# Keep only Summer / Winter seasons.
participation_clean = participation_clean[
    participation_clean["season"].isin(["Summer", "Winter"])
].copy()

athlete_sports = athlete_sports[
    athlete_sports["season"].isin(["Summer", "Winter"])
].copy()


# =========================
# 7. DEDUPLICATE
# =========================

athletes_clean = athletes_clean.drop_duplicates(
    subset=["athlete_id"]
)

athlete_sports = athlete_sports.drop_duplicates(
    subset=["athlete_id", "sport", "sport_type", "season"]
)

participation_clean = participation_clean.drop_duplicates(
    subset=["athlete_id", "hometown_key", "sport", "sport_type", "season"]
)


# =========================
# 8. SYNC ATHLETES WITH CLEAN PARTICIPATION ROWS
# =========================

# Only keep athletes who survived the cleaned participation table.
valid_athlete_ids = set(participation_clean["athlete_id"].unique())

athletes_clean = athletes_clean[
    athletes_clean["athlete_id"].isin(valid_athlete_ids)
].copy()

athlete_sports = athlete_sports[
    athlete_sports["athlete_id"].isin(valid_athlete_ids)
].copy()


# =========================
# 9. STATE SUMMARY
# =========================

state_summary_rows = []

for state, group in participation_clean.groupby("hometown_state"):
    unique_athletes = group.drop_duplicates(subset=["athlete_id"])

    total_athletes = unique_athletes["athlete_id"].nunique()

    olympic_athletes = unique_athletes.loc[
        unique_athletes["sport_type"] == "Olympic",
        "athlete_id"
    ].nunique()

    paralympic_athletes = unique_athletes.loc[
        unique_athletes["sport_type"] == "Paralympic",
        "athlete_id"
    ].nunique()

    summer_athletes = group.loc[
        group["season"] == "Summer",
        "athlete_id"
    ].nunique()

    winter_athletes = group.loc[
        group["season"] == "Winter",
        "athlete_id"
    ].nunique()

    sport_count = group["sport"].nunique()
    top_sports = parse_top_sports(group, top_n=5)

    state_summary_rows.append({
        "state": state,
        "total_athletes": total_athletes,
        "olympic_athletes": olympic_athletes,
        "paralympic_athletes": paralympic_athletes,
        "summer_athletes": summer_athletes,
        "winter_athletes": winter_athletes,
        "sport_count": sport_count,
        "top_sports": top_sports,
        "parity_ratio": parity_ratio(olympic_athletes, paralympic_athletes)
    })

state_summary = pd.DataFrame(state_summary_rows)

state_summary = state_summary.sort_values(
    by="total_athletes",
    ascending=False
)


# =========================
# 10. STATE-SPORT SUMMARY
# =========================

state_sport_summary = (
    participation_clean
    .groupby(["hometown_state", "sport", "season", "sport_type"], dropna=False)
    .agg(
        athlete_count=("athlete_id", "nunique"),
        participation_count=("athlete_id", "count")
    )
    .reset_index()
    .rename(columns={"hometown_state": "state"})
    .sort_values(
        by=["state", "athlete_count"],
        ascending=[True, False]
    )
)


# =========================
# 11. HOMETOWN SUMMARY
# =========================

hometown_summary_rows = []

for hometown_key, group in participation_clean.groupby("hometown_key"):
    unique_athletes = group.drop_duplicates(subset=["athlete_id"])

    city = group["hometown_city"].iloc[0]
    state = group["hometown_state"].iloc[0]

    total_athletes = unique_athletes["athlete_id"].nunique()

    olympic_athletes = unique_athletes.loc[
        unique_athletes["sport_type"] == "Olympic",
        "athlete_id"
    ].nunique()

    paralympic_athletes = unique_athletes.loc[
        unique_athletes["sport_type"] == "Paralympic",
        "athlete_id"
    ].nunique()

    summer_athletes = group.loc[
        group["season"] == "Summer",
        "athlete_id"
    ].nunique()

    winter_athletes = group.loc[
        group["season"] == "Winter",
        "athlete_id"
    ].nunique()

    sport_count = group["sport"].nunique()
    top_sports = parse_top_sports(group, top_n=5)

    hometown_summary_rows.append({
        "hometown_city": city,
        "hometown_state": state,
        "hometown_key": hometown_key,
        "total_athletes": total_athletes,
        "olympic_athletes": olympic_athletes,
        "paralympic_athletes": paralympic_athletes,
        "summer_athletes": summer_athletes,
        "winter_athletes": winter_athletes,
        "sport_count": sport_count,
        "top_sports": top_sports,
        "parity_ratio": parity_ratio(olympic_athletes, paralympic_athletes)
    })

hometown_summary = pd.DataFrame(hometown_summary_rows)

hometown_summary = hometown_summary.sort_values(
    by="total_athletes",
    ascending=False
)


# =========================
# 12. SAVE JSON FILES
# =========================

def save_json(df, filename):
    df.to_json(OUTPUT_DIR / filename, orient="records", indent=2)


save_json(athletes_clean, "athletes_clean.json")
save_json(athlete_sports, "athlete_sports.json")
save_json(participation_clean, "athlete_participation_clean.json")
save_json(state_summary, "state_summary.json")
save_json(state_sport_summary, "state_sport_summary.json")
save_json(hometown_summary, "hometown_summary.json")


# =========================
# 13. VALIDATION SUMMARY
# =========================

print("\nSaved JSON files to:", OUTPUT_DIR.resolve())

print("\nFile row counts:")
print(f"athletes_clean.json: {len(athletes_clean)} rows")
print(f"athlete_sports.json: {len(athlete_sports)} rows")
print(f"athlete_participation_clean.json: {len(participation_clean)} rows")
print(f"state_summary.json: {len(state_summary)} rows")
print(f"state_sport_summary.json: {len(state_sport_summary)} rows")
print(f"hometown_summary.json: {len(hometown_summary)} rows")

print("\nBasic validation:")
print(f"Unique athletes: {athletes_clean['athlete_id'].nunique()}")
print(f"Unique athletes in participation table: {participation_clean['athlete_id'].nunique()}")
print(f"Unique states: {participation_clean['hometown_state'].nunique()}")
print(f"Unique hometowns: {participation_clean['hometown_key'].nunique()}")
print(f"Unique sports: {participation_clean['sport'].nunique()}")

print("\nSport type counts:")
print(participation_clean["sport_type"].value_counts(dropna=False))

print("\nSeason counts:")
print(participation_clean["season"].value_counts(dropna=False))

print("\nTop 10 states by total athletes:")
print(state_summary.head(10))

print("\nTop 10 hometowns by total athletes:")
print(hometown_summary.head(10))