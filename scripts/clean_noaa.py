"""
Build data/climate_state_summary.json — per-state monthly + annual climate
normals from NOAA's nClimDiv 1991–2020 baseline.

What this produces
------------------
A JSON array of 49 rows (lower-48 states + Alaska, minus DC/HI/VI which
NOAA does not publish in this product), each shaped:

    {
      "state":                 "CA",
      "state_name":            "California",
      "noaa_state_code":       "004",
      "avg_annual_temp_f":     59.4,
      "avg_annual_precip_in":  22.6,
      "monthly_temp_jan":      46.3,   ...   "monthly_temp_dec":  47.0,
      "monthly_precip_jan":    4.21,   ...   "monthly_precip_dec": 3.85
    }

Inputs (downloaded fresh on every run; no local cache):
  - https://www.ncei.noaa.gov/pub/data/cirs/climdiv/climdiv-norm-tmpcst-v1.0.0-…
  - https://www.ncei.noaa.gov/pub/data/cirs/climdiv/climdiv-norm-pcpnst-v1.0.0-…

Both files are fixed-width plain text keyed by the NOAA 3-digit state code,
which we map to the standard 2-letter postal abbreviation before joining
temperature and precipitation into one row per state.

Run as a standalone script:
    python scripts/clean_noaa.py

The frontend reads the resulting JSON in /assets/js/data/loader.js (key
`climate`) and surfaces it in Atlas (right panel) and Compare Regions.
"""

import os

import requests
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_DIR, "data")


# NOAA nClimDiv normals source files
TEMP_URL = "https://www.ncei.noaa.gov/pub/data/cirs/climdiv/climdiv-norm-tmpcst-v1.0.0-20260506"
PRECIP_URL = "https://www.ncei.noaa.gov/pub/data/cirs/climdiv/climdiv-norm-pcpnst-v1.0.0-20260506"

MONTHS = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"
]

STATE_CODE_TO_NAME = {
    "001": "Alabama",
    "002": "Arizona",
    "003": "Arkansas",
    "004": "California",
    "005": "Colorado",
    "006": "Connecticut",
    "007": "Delaware",
    "008": "Florida",
    "009": "Georgia",
    "010": "Idaho",
    "011": "Illinois",
    "012": "Indiana",
    "013": "Iowa",
    "014": "Kansas",
    "015": "Kentucky",
    "016": "Louisiana",
    "017": "Maine",
    "018": "Maryland",
    "019": "Massachusetts",
    "020": "Michigan",
    "021": "Minnesota",
    "022": "Mississippi",
    "023": "Missouri",
    "024": "Montana",
    "025": "Nebraska",
    "026": "Nevada",
    "027": "New Hampshire",
    "028": "New Jersey",
    "029": "New Mexico",
    "030": "New York",
    "031": "North Carolina",
    "032": "North Dakota",
    "033": "Ohio",
    "034": "Oklahoma",
    "035": "Oregon",
    "036": "Pennsylvania",
    "037": "Rhode Island",
    "038": "South Carolina",
    "039": "South Dakota",
    "040": "Tennessee",
    "041": "Texas",
    "042": "Utah",
    "043": "Vermont",
    "044": "Virginia",
    "045": "Washington",
    "046": "West Virginia",
    "047": "Wisconsin",
    "048": "Wyoming",
    "050": "Alaska",
}

STATE_NAME_TO_ABBR = {
    "Alabama": "AL",
    "Alaska": "AK",
    "Arizona": "AZ",
    "Arkansas": "AR",
    "California": "CA",
    "Colorado": "CO",
    "Connecticut": "CT",
    "Delaware": "DE",
    "Florida": "FL",
    "Georgia": "GA",
    "Idaho": "ID",
    "Illinois": "IL",
    "Indiana": "IN",
    "Iowa": "IA",
    "Kansas": "KS",
    "Kentucky": "KY",
    "Louisiana": "LA",
    "Maine": "ME",
    "Maryland": "MD",
    "Massachusetts": "MA",
    "Michigan": "MI",
    "Minnesota": "MN",
    "Mississippi": "MS",
    "Missouri": "MO",
    "Montana": "MT",
    "Nebraska": "NE",
    "Nevada": "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    "Ohio": "OH",
    "Oklahoma": "OK",
    "Oregon": "OR",
    "Pennsylvania": "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    "Tennessee": "TN",
    "Texas": "TX",
    "Utah": "UT",
    "Vermont": "VT",
    "Virginia": "VA",
    "Washington": "WA",
    "West Virginia": "WV",
    "Wisconsin": "WI",
    "Wyoming": "WY",
}


def fetch_text_file(url):
    """Downloads a NOAA plain-text file."""
    response = requests.get(url)
    response.raise_for_status()
    return response.text


def parse_noaa_normals_file(text, expected_element_code):
    """
    Parses NOAA nClimDiv state-level normals files.

    First 10 characters:
    - positions 1-3: state code
    - position 4: division number
    - positions 5-6: element code
    - positions 7-10: period code

    For this project:
    - division number 0 = statewide value
    - period code 0010 = 1991-2020
    - element code 02 = average temperature
    - element code 01 = precipitation
    """

    rows = []

    for line in text.splitlines():
        line = line.strip()

        if not line:
            continue

        parts = line.split()
        code = parts[0]

        if len(code) != 10:
            continue

        state_code = code[0:3]
        division_number = code[3:4]
        element_code = code[4:6]
        period_code = code[6:10]

        # Keep only statewide 1991-2020 rows for the expected climate variable
        if division_number != "0":
            continue

        if period_code != "0010":
            continue

        if element_code != expected_element_code:
            continue

        if state_code not in STATE_CODE_TO_NAME:
            continue

        monthly_values = [float(value) for value in parts[1:13]]

        state_name = STATE_CODE_TO_NAME[state_code]
        state_abbr = STATE_NAME_TO_ABBR[state_name]

        row = {
            "state": state_abbr,
            "state_name": state_name,
            "noaa_state_code": state_code,
        }

        for month, value in zip(MONTHS, monthly_values):
            row[month] = value

        rows.append(row)

    return pd.DataFrame(rows)


def main():
    # Download NOAA source files
    temp_text = fetch_text_file(TEMP_URL)
    precip_text = fetch_text_file(PRECIP_URL)

    # Parse files
    temp_df = parse_noaa_normals_file(temp_text, expected_element_code="02")
    precip_df = parse_noaa_normals_file(precip_text, expected_element_code="01")

    # Rename monthly columns
    temp_df = temp_df.rename(columns={month: f"monthly_temp_{month}" for month in MONTHS})
    precip_df = precip_df.rename(columns={month: f"monthly_precip_{month}" for month in MONTHS})

    temp_month_cols = [f"monthly_temp_{month}" for month in MONTHS]
    precip_month_cols = [f"monthly_precip_{month}" for month in MONTHS]

    # Calculate summary metrics
    temp_df["avg_annual_temp_f"] = temp_df[temp_month_cols].mean(axis=1)
    precip_df["avg_annual_precip_in"] = precip_df[precip_month_cols].sum(axis=1)

    # Merge temperature + precipitation into one final dataset
    climate_df = temp_df[
        [
            "state",
            "state_name",
            "noaa_state_code",
            "avg_annual_temp_f",
        ] + temp_month_cols
    ].merge(
        precip_df[
            [
                "state",
                "state_name",
                "noaa_state_code",
                "avg_annual_precip_in",
            ] + precip_month_cols
        ],
        on=["state", "state_name", "noaa_state_code"],
        how="inner"
    )

    # Round annual values for cleaner display
    climate_df["avg_annual_temp_f"] = climate_df["avg_annual_temp_f"].round(2)
    climate_df["avg_annual_precip_in"] = climate_df["avg_annual_precip_in"].round(2)

    # Save only the final cleaned dataset as JSON
    os.makedirs(DATA_DIR, exist_ok=True)
    output_path = os.path.join(DATA_DIR, "climate_state_summary.json")
    climate_df.to_json(
        output_path,
        orient="records",
        indent=2
    )

    print(f"Saved {len(climate_df)} rows to {output_path}")
    print(climate_df.head())


if __name__ == "__main__":
    main()