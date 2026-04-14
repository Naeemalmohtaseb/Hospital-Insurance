"""Build app-ready CareFinder data tables from local hospital project data.

The canonical output is one hospital x procedure row, with hospital location,
quality, and a documented estimated-cost hierarchy for frontend ranking.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "Data"
APP_DATA_DIR = PROJECT_ROOT / "app" / "data"
OUTPUT_DIR = PROJECT_ROOT / "outputs" / "carefinder"

PRIMARY_SOURCE_CANDIDATES = (
    "thesis_merged_with_turquoise.csv",
    "thesis_working_dataset.csv",
    "medicare_core_with_hospital_info.csv",
    "medicare_core_clean.csv",
)

HOSPITAL_INFO_SOURCE = DATA_DIR / "Hospital_General_Information.csv.xlsx"
ANALYSIS_HOSPITAL_SOURCE = DATA_DIR / "analysis_hospital_level_ready.csv"
MEDICARE_LOCATION_CANDIDATES = (
    DATA_DIR / "medicare_core_clean.csv",
    DATA_DIR / "medicare_core_working.csv",
    DATA_DIR / "medicare_working_dataset.csv",
)

PRIMARY_USECOLS = (
    "CCN",
    "Rndrng_Prvdr_CCN",
    "Rndrng_Prvdr_Org_Name",
    "Rndrng_Prvdr_City",
    "Rndrng_Prvdr_St",
    "Rndrng_Prvdr_Zip5",
    "Rndrng_Prvdr_State_Abrvtn",
    "PROVIDER_ID",
    "PROVIDER_NAME",
    "PROVIDER_STATE",
    "provider_id",
    "DRG_Cd",
    "DRG_CODE",
    "DRG_Desc",
    "DRG_DESC",
    "Tot_Dschrgs",
    "Avg_Submtd_Cvrd_Chrg",
    "Avg_Tot_Pymt_Amt",
    "Avg_Mdcr_Pymt_Amt",
    "Year",
    "Hospital Type",
    "Hospital Ownership",
    "Emergency Services",
    "Hospital overall rating",
    "rating_num",
    "AVG_COMMERCIAL",
    "AVG_MEDICARE_ADVANTAGE",
    "AVG_MEDICARE_FFS",
    "AVG_GROSS_CHARGE",
    "has_hosp_info",
    "has_turquoise",
)

PRICE_FALLBACKS = (
    ("avg_commercial", "avg_commercial"),
    ("avg_medicare_advantage", "avg_medicare_advantage"),
    ("avg_medicare_ffs", "avg_medicare_ffs"),
    ("medicare_total_payment", "medicare_total_payment"),
)

PRICE_SOURCE_LABELS = {
    "avg_commercial": "Turquoise AVG_COMMERCIAL negotiated commercial estimate",
    "avg_medicare_advantage": "Turquoise AVG_MEDICARE_ADVANTAGE private-plan estimate",
    "avg_medicare_ffs": "Turquoise AVG_MEDICARE_FFS public-payer benchmark",
    "medicare_total_payment": "CMS Medicare Avg_Tot_Pymt_Amt fallback",
}

CANONICAL_COLUMNS = [
    "hospital_id",
    "CCN",
    "hospital_name",
    "address",
    "city",
    "state",
    "zip",
    "full_address",
    "latitude",
    "longitude",
    "procedure_code",
    "procedure_name",
    "source_year",
    "estimated_cost",
    "estimated_cost_source",
    "estimated_cost_source_label",
    "has_price",
    "quality_rating",
    "high_quality",
    "has_quality",
    "commercial_to_medicare",
    "charge_to_medicare",
    "hospital_commercial_to_medicare",
    "hospital_charge_to_medicare",
    "medicare_total_payment",
    "medicare_payment",
    "submitted_charge",
    "avg_commercial",
    "avg_medicare_advantage",
    "avg_medicare_ffs",
    "avg_gross_charge",
    "total_discharges",
    "hospital_type",
    "hospital_ownership",
    "emergency_services",
    "cost_percentile_within_procedure",
    "cost_score_0_100",
    "quality_score_0_100",
    "value_score_base",
    "data_source",
    "price_provider_count",
    "source_row_count",
]

LOGGER = logging.getLogger("carefinder.build")


def read_csv_columns(path: Path) -> list[str]:
    return list(pd.read_csv(path, nrows=0).columns)


def available_usecols(path: Path, desired_columns: Iterable[str]) -> list[str]:
    available = set(read_csv_columns(path))
    return [column for column in desired_columns if column in available]


def first_existing(columns: Iterable[str], candidates: Iterable[str]) -> str | None:
    available = set(columns)
    for candidate in candidates:
        if candidate in available:
            return candidate
    return None


def source_series(df: pd.DataFrame, candidates: Iterable[str]) -> pd.Series:
    for column in candidates:
        if column in df.columns:
            return df[column]
    return pd.Series(pd.NA, index=df.index, dtype="object")


def normalize_digits(series: pd.Series, width: int) -> pd.Series:
    as_text = series.astype("string").str.replace(r"\D+", "", regex=True).str.strip()
    as_text = as_text.mask(as_text.eq(""))
    return as_text.str.zfill(width)


def normalize_ccn(series: pd.Series) -> pd.Series:
    return normalize_digits(series, 6)


def normalize_drg(series: pd.Series) -> pd.Series:
    return normalize_digits(series, 3)


def clean_text(series: pd.Series) -> pd.Series:
    cleaned = series.astype("string").str.strip()
    return cleaned.mask(cleaned.eq("") | cleaned.str.lower().isin({"nan", "none", "not available"}))


def clean_state(series: pd.Series) -> pd.Series:
    return clean_text(series).str.upper()


def clean_zip(series: pd.Series) -> pd.Series:
    digits = series.astype("string").str.replace(r"\D+", "", regex=True).str.strip()
    digits = digits.mask(digits.eq(""))
    return digits.str.slice(0, 5).str.zfill(5)


def to_number(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def first_valid(series: pd.Series) -> object:
    valid = clean_text(series).dropna()
    if valid.empty:
        return pd.NA
    return valid.iloc[0]


def first_numeric(series: pd.Series) -> object:
    valid = pd.to_numeric(series, errors="coerce").dropna()
    if valid.empty:
        return pd.NA
    return valid.iloc[0]


def coalesce_text(series_list: Iterable[pd.Series], index: pd.Index) -> pd.Series:
    output = pd.Series(pd.NA, index=index, dtype="object")
    for series in series_list:
        output = output.mask(output.isna(), clean_text(series))
    return output


def coalesce_numeric(series_list: Iterable[pd.Series], index: pd.Index) -> pd.Series:
    output = pd.Series(pd.NA, index=index, dtype="Float64")
    for series in series_list:
        numeric = pd.to_numeric(series, errors="coerce").astype("Float64")
        output = output.mask(output.isna(), numeric)
    return output


def safe_divide(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    numerator_num = pd.to_numeric(numerator, errors="coerce")
    denominator_num = pd.to_numeric(denominator, errors="coerce")
    result = numerator_num / denominator_num.where(denominator_num > 0)
    return result.replace([float("inf"), float("-inf")], pd.NA)


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(PROJECT_ROOT))
    except ValueError:
        return str(path)


def select_primary_source() -> Path:
    missing: list[str] = []
    for file_name in PRIMARY_SOURCE_CANDIDATES:
        path = DATA_DIR / file_name
        if not path.exists():
            missing.append(file_name)
            continue

        columns = read_csv_columns(path)
        has_hospital = first_existing(columns, ("CCN", "Rndrng_Prvdr_CCN")) is not None
        has_procedure = first_existing(columns, ("DRG_Cd", "DRG_CODE")) is not None
        if has_hospital and has_procedure:
            LOGGER.info("Selected primary hospital-procedure source: %s", relative(path))
            if missing:
                LOGGER.info("Skipped missing higher-priority candidates: %s", ", ".join(missing))
            return path

        LOGGER.warning("Skipping %s because it lacks hospital or DRG identifiers.", relative(path))

    raise FileNotFoundError(
        "No usable hospital-procedure source was found. Expected one of: "
        + ", ".join(PRIMARY_SOURCE_CANDIDATES)
    )


def load_primary_panel(path: Path) -> pd.DataFrame:
    usecols = available_usecols(path, PRIMARY_USECOLS)
    raw = pd.read_csv(path, dtype=str, usecols=usecols, low_memory=False)

    panel = pd.DataFrame(index=raw.index)
    panel["hospital_id"] = normalize_ccn(source_series(raw, ("CCN", "Rndrng_Prvdr_CCN")))
    panel["hospital_name"] = clean_text(
        source_series(raw, ("Rndrng_Prvdr_Org_Name", "PROVIDER_NAME"))
    )
    panel["primary_state"] = clean_state(
        source_series(raw, ("Rndrng_Prvdr_State_Abrvtn", "PROVIDER_STATE"))
    )
    panel["procedure_code"] = normalize_drg(source_series(raw, ("DRG_Cd", "DRG_CODE")))
    panel["procedure_name"] = clean_text(source_series(raw, ("DRG_Desc", "DRG_DESC")))
    panel["source_year"] = to_number(source_series(raw, ("Year",)))
    panel["provider_id"] = clean_text(source_series(raw, ("PROVIDER_ID", "provider_id")))

    numeric_mappings = {
        "total_discharges": ("Tot_Dschrgs",),
        "submitted_charge": ("Avg_Submtd_Cvrd_Chrg",),
        "medicare_total_payment": ("Avg_Tot_Pymt_Amt",),
        "medicare_payment": ("Avg_Mdcr_Pymt_Amt",),
        "primary_quality_rating": ("Hospital overall rating", "rating_num"),
        "avg_commercial": ("AVG_COMMERCIAL",),
        "avg_medicare_advantage": ("AVG_MEDICARE_ADVANTAGE",),
        "avg_medicare_ffs": ("AVG_MEDICARE_FFS",),
        "avg_gross_charge": ("AVG_GROSS_CHARGE",),
        "has_hosp_info": ("has_hosp_info",),
        "has_turquoise": ("has_turquoise",),
    }
    for output_col, input_cols in numeric_mappings.items():
        panel[output_col] = to_number(source_series(raw, input_cols))

    panel["hospital_type_primary"] = clean_text(source_series(raw, ("Hospital Type",)))
    panel["hospital_ownership_primary"] = clean_text(source_series(raw, ("Hospital Ownership",)))
    panel["emergency_services_primary"] = clean_text(source_series(raw, ("Emergency Services",)))
    panel["data_source"] = path.name

    before = len(panel)
    panel = panel.dropna(subset=["hospital_id", "procedure_code"]).copy()
    dropped = before - len(panel)
    if dropped:
        LOGGER.warning("Dropped %s primary rows without hospital_id or procedure_code.", dropped)

    LOGGER.info("Loaded %s rows from %s.", len(panel), relative(path))
    return panel


def count_unique_nonblank(series: pd.Series) -> int:
    return int(clean_text(series).nunique(dropna=True))


def collapse_duplicate_primary_rows(panel: pd.DataFrame) -> pd.DataFrame:
    """Collapse duplicate hospital-procedure-year rows from multi-provider matches."""
    keys = ["hospital_id", "procedure_code", "source_year"]
    text_cols = [
        "hospital_name",
        "primary_state",
        "procedure_name",
        "hospital_type_primary",
        "hospital_ownership_primary",
        "emergency_services_primary",
        "data_source",
    ]
    numeric_cols = [
        "total_discharges",
        "submitted_charge",
        "medicare_total_payment",
        "medicare_payment",
        "primary_quality_rating",
        "avg_commercial",
        "avg_medicare_advantage",
        "avg_medicare_ffs",
        "avg_gross_charge",
        "has_hosp_info",
        "has_turquoise",
    ]

    grouped = panel.groupby(keys, dropna=False)
    text_part = grouped[text_cols].agg(first_valid)
    numeric_part = grouped[numeric_cols].median()
    source_row_count = grouped.size().rename("source_row_count")
    provider_count = grouped["provider_id"].agg(count_unique_nonblank).rename("price_provider_count")

    collapsed = pd.concat([text_part, numeric_part, source_row_count, provider_count], axis=1).reset_index()
    duplicate_rows = int(collapsed["source_row_count"].sum() - len(collapsed))
    if duplicate_rows:
        LOGGER.info(
            "Collapsed %s duplicate rows from multiple Turquoise/provider matches using median numeric values.",
            duplicate_rows,
        )
    return collapsed


def select_latest_hospital_procedure_rows(panel: pd.DataFrame) -> pd.DataFrame:
    sorted_panel = panel.assign(source_year_sort=panel["source_year"].fillna(-1))
    sorted_panel = sorted_panel.sort_values(
        ["hospital_id", "procedure_code", "source_year_sort", "price_provider_count"]
    )
    latest = sorted_panel.drop_duplicates(["hospital_id", "procedure_code"], keep="last").copy()
    latest = latest.drop(columns=["source_year_sort"])
    latest["source_year"] = latest["source_year"].round().astype("Int64")
    LOGGER.info(
        "Selected %s latest hospital-procedure rows across %s hospitals and %s procedures.",
        len(latest),
        latest["hospital_id"].nunique(),
        latest["procedure_code"].nunique(),
    )
    return latest


def load_hospital_info() -> pd.DataFrame:
    columns = [
        "Facility ID",
        "Facility Name",
        "Address",
        "City/Town",
        "State",
        "ZIP Code",
        "Hospital Type",
        "Hospital Ownership",
        "Emergency Services",
        "Hospital overall rating",
    ]
    output_cols = [
        "hospital_id",
        "hinfo_hospital_name",
        "hinfo_address",
        "hinfo_city",
        "hinfo_state",
        "hinfo_zip",
        "hinfo_hospital_type",
        "hinfo_hospital_ownership",
        "hinfo_emergency_services",
        "hinfo_quality_rating",
    ]
    if not HOSPITAL_INFO_SOURCE.exists():
        LOGGER.warning("Hospital info workbook not found: %s", relative(HOSPITAL_INFO_SOURCE))
        return pd.DataFrame(columns=output_cols)

    raw = pd.read_excel(HOSPITAL_INFO_SOURCE, dtype=str, usecols=lambda col: col in columns)
    info = pd.DataFrame(index=raw.index)
    info["hospital_id"] = normalize_ccn(source_series(raw, ("Facility ID",)))
    info["hinfo_hospital_name"] = clean_text(source_series(raw, ("Facility Name",)))
    info["hinfo_address"] = clean_text(source_series(raw, ("Address",)))
    info["hinfo_city"] = clean_text(source_series(raw, ("City/Town",)))
    info["hinfo_state"] = clean_state(source_series(raw, ("State",)))
    info["hinfo_zip"] = clean_zip(source_series(raw, ("ZIP Code",)))
    info["hinfo_hospital_type"] = clean_text(source_series(raw, ("Hospital Type",)))
    info["hinfo_hospital_ownership"] = clean_text(source_series(raw, ("Hospital Ownership",)))
    info["hinfo_emergency_services"] = clean_text(source_series(raw, ("Emergency Services",)))
    info["hinfo_quality_rating"] = to_number(source_series(raw, ("Hospital overall rating",)))

    info = info.dropna(subset=["hospital_id"]).drop_duplicates("hospital_id", keep="first")
    LOGGER.info("Loaded %s hospital lookup rows from %s.", len(info), relative(HOSPITAL_INFO_SOURCE))
    return info[output_cols]


def load_hospital_analysis() -> pd.DataFrame:
    output_cols = [
        "hospital_id",
        "analysis_hospital_name",
        "analysis_state",
        "analysis_quality_rating",
        "hospital_commercial_to_medicare",
        "hospital_charge_to_medicare",
        "hospital_ma_to_medicare",
        "analysis_has_turquoise",
        "analysis_has_hosp_info",
        "analysis_total_discharges",
        "analysis_ruca_desc",
        "analysis_hospital_type",
        "analysis_hospital_ownership",
        "analysis_emergency_services",
    ]
    if not ANALYSIS_HOSPITAL_SOURCE.exists():
        LOGGER.warning("Hospital analysis source not found: %s", relative(ANALYSIS_HOSPITAL_SOURCE))
        return pd.DataFrame(columns=output_cols)

    desired = [
        "CCN",
        "STATE",
        "rating_num",
        "commercial_to_medicare",
        "charge_to_medicare",
        "ma_to_medicare",
        "has_turquoise",
        "has_hosp_info",
        "Tot_Dschrgs_sum",
        "Rndrng_Prvdr_Org_Name",
        "Rndrng_Prvdr_State_Abrvtn",
        "Rndrng_Prvdr_RUCA_Desc",
        "Hospital Type",
        "Hospital Ownership",
        "Emergency Services",
    ]
    raw = pd.read_csv(
        ANALYSIS_HOSPITAL_SOURCE,
        dtype=str,
        usecols=available_usecols(ANALYSIS_HOSPITAL_SOURCE, desired),
        low_memory=False,
    )

    analysis = pd.DataFrame(index=raw.index)
    analysis["hospital_id"] = normalize_ccn(source_series(raw, ("CCN",)))
    analysis["analysis_hospital_name"] = clean_text(source_series(raw, ("Rndrng_Prvdr_Org_Name",)))
    analysis["analysis_state"] = clean_state(source_series(raw, ("STATE", "Rndrng_Prvdr_State_Abrvtn")))
    analysis["analysis_quality_rating"] = to_number(source_series(raw, ("rating_num",)))
    analysis["hospital_commercial_to_medicare"] = to_number(
        source_series(raw, ("commercial_to_medicare",))
    )
    analysis["hospital_charge_to_medicare"] = to_number(source_series(raw, ("charge_to_medicare",)))
    analysis["hospital_ma_to_medicare"] = to_number(source_series(raw, ("ma_to_medicare",)))
    analysis["analysis_has_turquoise"] = to_number(source_series(raw, ("has_turquoise",)))
    analysis["analysis_has_hosp_info"] = to_number(source_series(raw, ("has_hosp_info",)))
    analysis["analysis_total_discharges"] = to_number(source_series(raw, ("Tot_Dschrgs_sum",)))
    analysis["analysis_ruca_desc"] = clean_text(source_series(raw, ("Rndrng_Prvdr_RUCA_Desc",)))
    analysis["analysis_hospital_type"] = clean_text(source_series(raw, ("Hospital Type",)))
    analysis["analysis_hospital_ownership"] = clean_text(source_series(raw, ("Hospital Ownership",)))
    analysis["analysis_emergency_services"] = clean_text(source_series(raw, ("Emergency Services",)))

    analysis = analysis.dropna(subset=["hospital_id"]).drop_duplicates("hospital_id", keep="first")
    LOGGER.info("Loaded %s hospital analysis rows from %s.", len(analysis), relative(ANALYSIS_HOSPITAL_SOURCE))
    return analysis[output_cols]


def load_medicare_location_fallback() -> pd.DataFrame:
    selected_path = next((path for path in MEDICARE_LOCATION_CANDIDATES if path.exists()), None)
    output_cols = [
        "hospital_id",
        "medicare_hospital_name",
        "medicare_address",
        "medicare_city",
        "medicare_state",
        "medicare_zip",
    ]
    if selected_path is None:
        LOGGER.warning("No Medicare location fallback source found.")
        return pd.DataFrame(columns=output_cols)

    desired = [
        "Rndrng_Prvdr_CCN",
        "CCN",
        "Rndrng_Prvdr_Org_Name",
        "Rndrng_Prvdr_City",
        "Rndrng_Prvdr_St",
        "Rndrng_Prvdr_Zip5",
        "Rndrng_Prvdr_State_Abrvtn",
    ]
    raw = pd.read_csv(
        selected_path,
        dtype=str,
        usecols=available_usecols(selected_path, desired),
        low_memory=False,
    )

    location = pd.DataFrame(index=raw.index)
    location["hospital_id"] = normalize_ccn(source_series(raw, ("Rndrng_Prvdr_CCN", "CCN")))
    location["medicare_hospital_name"] = clean_text(source_series(raw, ("Rndrng_Prvdr_Org_Name",)))
    location["medicare_address"] = clean_text(source_series(raw, ("Rndrng_Prvdr_St",)))
    location["medicare_city"] = clean_text(source_series(raw, ("Rndrng_Prvdr_City",)))
    location["medicare_state"] = clean_state(source_series(raw, ("Rndrng_Prvdr_State_Abrvtn",)))
    location["medicare_zip"] = clean_zip(source_series(raw, ("Rndrng_Prvdr_Zip5",)))

    location = location.dropna(subset=["hospital_id"])
    grouped = location.groupby("hospital_id", dropna=False).agg(first_valid).reset_index()
    LOGGER.info("Loaded %s Medicare location fallback rows from %s.", len(grouped), relative(selected_path))
    return grouped[output_cols]


def build_full_address(df: pd.DataFrame) -> pd.Series:
    def join_parts(row: pd.Series) -> object:
        parts = [row.get("address"), row.get("city"), row.get("state"), row.get("zip")]
        valid_parts = [str(part).strip() for part in parts if pd.notna(part) and str(part).strip()]
        return ", ".join(valid_parts) if valid_parts else pd.NA

    return df.apply(join_parts, axis=1)


def enrich_panel(
    panel: pd.DataFrame,
    hospital_info: pd.DataFrame,
    hospital_analysis: pd.DataFrame,
    medicare_location: pd.DataFrame,
) -> pd.DataFrame:
    df = panel.merge(hospital_info, on="hospital_id", how="left")
    df = df.merge(hospital_analysis, on="hospital_id", how="left")
    df = df.merge(medicare_location, on="hospital_id", how="left")

    df["CCN"] = df["hospital_id"]
    df["hospital_name"] = coalesce_text(
        [
            df["hospital_name"],
            df["hinfo_hospital_name"],
            df["medicare_hospital_name"],
            df["analysis_hospital_name"],
        ],
        df.index,
    )
    df["address"] = coalesce_text([df["hinfo_address"], df["medicare_address"]], df.index)
    df["city"] = coalesce_text([df["hinfo_city"], df["medicare_city"]], df.index)
    df["state"] = clean_state(
        coalesce_text(
            [df["primary_state"], df["hinfo_state"], df["medicare_state"], df["analysis_state"]],
            df.index,
        )
    )
    df["zip"] = clean_zip(coalesce_text([df["hinfo_zip"], df["medicare_zip"]], df.index))
    df["full_address"] = build_full_address(df)
    df["latitude"] = pd.NA
    df["longitude"] = pd.NA

    df["quality_rating"] = coalesce_numeric(
        [df["hinfo_quality_rating"], df["primary_quality_rating"], df["analysis_quality_rating"]],
        df.index,
    )
    df["hospital_type"] = coalesce_text(
        [df["hinfo_hospital_type"], df["hospital_type_primary"], df["analysis_hospital_type"]],
        df.index,
    )
    df["hospital_ownership"] = coalesce_text(
        [
            df["hinfo_hospital_ownership"],
            df["hospital_ownership_primary"],
            df["analysis_hospital_ownership"],
        ],
        df.index,
    )
    df["emergency_services"] = coalesce_text(
        [
            df["hinfo_emergency_services"],
            df["emergency_services_primary"],
            df["analysis_emergency_services"],
        ],
        df.index,
    )
    return df


def compute_estimated_cost(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["estimated_cost"] = pd.Series(pd.NA, index=df.index, dtype="Float64")
    df["estimated_cost_source"] = pd.Series(pd.NA, index=df.index, dtype="object")

    for column, source_name in PRICE_FALLBACKS:
        values = pd.to_numeric(df[column], errors="coerce")
        use_value = df["estimated_cost"].isna() & values.notna() & (values > 0)
        df.loc[use_value, "estimated_cost"] = values.loc[use_value]
        df.loc[use_value, "estimated_cost_source"] = source_name

    df["estimated_cost_source_label"] = df["estimated_cost_source"].map(PRICE_SOURCE_LABELS)
    df["has_price"] = df["estimated_cost"].notna()

    df["commercial_to_medicare"] = safe_divide(df["avg_commercial"], df["medicare_payment"])
    df["charge_to_medicare"] = safe_divide(df["submitted_charge"], df["medicare_payment"])

    df["has_quality"] = df["quality_rating"].notna()
    df["high_quality"] = (df["quality_rating"] >= 4).where(df["has_quality"], pd.NA).astype("boolean")
    return df


def compute_rank_fields(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["cost_percentile_within_procedure"] = df.groupby("procedure_code")["estimated_cost"].rank(
        method="average",
        pct=True,
        ascending=True,
    )
    df.loc[~df["has_price"], "cost_percentile_within_procedure"] = pd.NA
    df["cost_score_0_100"] = (1 - df["cost_percentile_within_procedure"]) * 100
    df["quality_score_0_100"] = (df["quality_rating"] / 5) * 100
    df["quality_score_0_100"] = df["quality_score_0_100"].clip(lower=0, upper=100)
    df["value_score_base"] = pd.NA
    has_value_inputs = df["has_price"] & df["has_quality"]
    df.loc[has_value_inputs, "value_score_base"] = (
        df.loc[has_value_inputs, ["cost_score_0_100", "quality_score_0_100"]].mean(axis=1)
    )

    rounded_columns = [
        "estimated_cost",
        "commercial_to_medicare",
        "charge_to_medicare",
        "hospital_commercial_to_medicare",
        "hospital_charge_to_medicare",
        "medicare_total_payment",
        "medicare_payment",
        "submitted_charge",
        "avg_commercial",
        "avg_medicare_advantage",
        "avg_medicare_ffs",
        "avg_gross_charge",
        "cost_percentile_within_procedure",
        "cost_score_0_100",
        "quality_score_0_100",
        "value_score_base",
    ]
    for column in rounded_columns:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce").round(4)
    return df


def make_procedure_lookup(df: pd.DataFrame) -> pd.DataFrame:
    working = df.copy()
    working["uses_commercial_estimate"] = working["estimated_cost_source"].eq("avg_commercial")
    procedures = (
        working.groupby(["procedure_code", "procedure_name"], dropna=False)
        .agg(
            row_count=("hospital_id", "size"),
            hospital_count=("hospital_id", "nunique"),
            state_count=("state", lambda value: clean_text(value).nunique(dropna=True)),
            price_rows=("has_price", "sum"),
            quality_rows=("has_quality", "sum"),
            commercial_price_rows=("uses_commercial_estimate", "sum"),
            median_estimated_cost=("estimated_cost", "median"),
            min_estimated_cost=("estimated_cost", "min"),
            max_estimated_cost=("estimated_cost", "max"),
            median_quality_rating=("quality_rating", "median"),
            min_source_year=("source_year", "min"),
            max_source_year=("source_year", "max"),
        )
        .reset_index()
        .sort_values(["procedure_code", "procedure_name"])
    )
    return procedures


def make_hospital_lookup(df: pd.DataFrame) -> pd.DataFrame:
    working = df.copy()
    working["uses_commercial_estimate"] = working["estimated_cost_source"].eq("avg_commercial")
    grouped = working.groupby("hospital_id", dropna=False)

    hospital_text = grouped[
        [
            "CCN",
            "hospital_name",
            "address",
            "city",
            "state",
            "zip",
            "full_address",
            "latitude",
            "longitude",
            "hospital_type",
            "hospital_ownership",
            "emergency_services",
            "high_quality",
            "data_source",
        ]
    ].agg(first_valid)
    hospital_numbers = grouped[
        [
            "quality_rating",
            "hospital_commercial_to_medicare",
            "hospital_charge_to_medicare",
        ]
    ].agg(first_numeric)
    hospital_counts = grouped.agg(
        procedure_count=("procedure_code", "nunique"),
        price_rows=("has_price", "sum"),
        quality_rows=("has_quality", "sum"),
        commercial_price_rows=("uses_commercial_estimate", "sum"),
        median_estimated_cost=("estimated_cost", "median"),
        median_value_score_base=("value_score_base", "median"),
        min_source_year=("source_year", "min"),
        max_source_year=("source_year", "max"),
    )

    hospitals = pd.concat([hospital_text, hospital_numbers, hospital_counts], axis=1).reset_index()
    hospitals = hospitals.sort_values(["state", "hospital_name", "hospital_id"])
    return hospitals


def ensure_output_columns(df: pd.DataFrame) -> pd.DataFrame:
    for column in CANONICAL_COLUMNS:
        if column not in df.columns:
            df[column] = pd.NA
    return df[CANONICAL_COLUMNS].sort_values(["state", "hospital_name", "procedure_code"])


def write_summary(
    canonical: pd.DataFrame,
    procedures: pd.DataFrame,
    hospitals: pd.DataFrame,
    primary_source: Path,
    output_paths: dict[str, Path],
) -> None:
    price_counts = canonical["estimated_cost_source"].value_counts(dropna=False).rename_axis("source")
    price_count_lines = [
        f"- `{source}`: {count:,} rows ({PRICE_SOURCE_LABELS.get(str(source), 'missing')})"
        for source, count in price_counts.items()
    ]

    year_counts = canonical["source_year"].value_counts(dropna=False).sort_index()
    year_lines = [f"- {year}: {count:,} rows" for year, count in year_counts.items()]

    address_missing = int(canonical["address"].isna().sum())
    quality_missing = int(canonical["quality_rating"].isna().sum())
    price_missing = int(canonical["estimated_cost"].isna().sum())
    latest_year_min = canonical["source_year"].min()
    latest_year_max = canonical["source_year"].max()

    lines = [
        "# CareFinder Backend Summary",
        "",
        "## Selected Sources",
        "",
        f"- Primary hospital-procedure panel: `{relative(primary_source)}`.",
        f"- Hospital address and current quality enrichment: `{relative(HOSPITAL_INFO_SOURCE)}`.",
        f"- Hospital-level analytic ratios: `{relative(ANALYSIS_HOSPITAL_SOURCE)}`.",
        "- Medicare location fallback: first available of "
        + ", ".join(f"`{relative(path)}`" for path in MEDICARE_LOCATION_CANDIDATES)
        + ".",
        "",
        "The builder prefers the cleaned merged hospital-DRG source over raw files because it already combines Medicare DRG rows, hospital information, and Turquoise price fields. Raw `Insurance.csv` is not read by the builder because it is very large and is already represented in the cleaned Turquoise panel.",
        "",
        "## Field Mapping",
        "",
        "| CareFinder field | Source logic |",
        "|---|---|",
        "| `hospital_id`, `CCN` | Normalized six-digit CCN from `CCN`, `Rndrng_Prvdr_CCN`, or `Facility ID`. |",
        "| `hospital_name` | Primary panel name, then hospital info workbook, then Medicare fallback. |",
        "| `address`, `city`, `state`, `zip` | Hospital info workbook first; Medicare provider address fields as fallback. |",
        "| `procedure_code`, `procedure_name` | DRG code and DRG description from the primary hospital-DRG panel. |",
        "| `quality_rating` | Hospital info `Hospital overall rating`, then primary panel rating, then hospital-level `rating_num`. |",
        "| `high_quality` | Derived only from real quality rating: `quality_rating >= 4`. |",
        "| `commercial_to_medicare` | Procedure-level `AVG_COMMERCIAL / Avg_Mdcr_Pymt_Amt` when both are available. |",
        "| `charge_to_medicare` | Procedure-level submitted charge divided by Medicare payment. |",
        "",
        "## Estimated Cost Definition",
        "",
        "`estimated_cost` is intended for consumer-style comparison, so the builder prioritizes paid or negotiated amounts and does not use gross charges as a final fallback. The documented hierarchy is:",
        "",
        "1. Turquoise `AVG_COMMERCIAL` negotiated commercial estimate.",
        "2. Turquoise `AVG_MEDICARE_ADVANTAGE` private-plan estimate.",
        "3. Turquoise `AVG_MEDICARE_FFS` public-payer benchmark.",
        "4. CMS Medicare `Avg_Tot_Pymt_Amt` fallback.",
        "",
        "Rows keep `estimated_cost_source` and `estimated_cost_source_label` so the frontend can distinguish mixed price concepts. Gross charge fields are preserved for reference but excluded from the estimated-cost hierarchy.",
        "",
        "Estimated-cost source counts:",
        "",
        *price_count_lines,
        "",
        "## Duplicate and Latest-Year Handling",
        "",
        "The primary merged file can contain more than one Turquoise provider match for the same CCN, DRG, and year. The builder collapses those duplicate matches to one hospital-procedure-year row using the median of numeric price/payment fields and first non-missing descriptive fields. It then keeps the latest available Medicare year for each hospital-procedure pair.",
        "",
        "Latest source-year distribution:",
        "",
        *year_lines,
        "",
        "## Output Files",
        "",
        f"- Canonical hospital-procedure table: `{relative(output_paths['canonical'])}` ({len(canonical):,} rows).",
        f"- Procedure lookup: `{relative(output_paths['procedures'])}` ({len(procedures):,} rows).",
        f"- Hospital lookup: `{relative(output_paths['hospitals'])}` ({len(hospitals):,} rows).",
        "",
        "## Missingness and Limitations",
        "",
        f"- Hospitals: {canonical['hospital_id'].nunique():,}. Procedures: {canonical['procedure_code'].nunique():,}. Latest source years range from {latest_year_min} to {latest_year_max}.",
        f"- Rows missing address after workbook plus Medicare fallback: {address_missing:,}.",
        f"- Rows missing quality rating: {quality_missing:,}.",
        f"- Rows missing estimated cost after the documented fallback hierarchy: {price_missing:,}.",
        "- Quality is hospital-level, not procedure-specific.",
        "- The current cleaned analytic panel contains the DRG procedures available in the thesis/Turquoise merge; it is not a universal procedure catalog.",
        "- Latitude and longitude are intentionally left blank. No external geocoding or web APIs are used.",
        "- Distance and user-location ranking should be added in a later geospatial step.",
        "",
    ]

    summary_path = output_paths["summary"]
    summary_path.write_text("\n".join(lines), encoding="utf-8")
    LOGGER.info("Wrote %s", relative(summary_path))


def write_outputs(
    canonical: pd.DataFrame,
    procedures: pd.DataFrame,
    hospitals: pd.DataFrame,
    primary_source: Path,
) -> dict[str, Path]:
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    paths = {
        "canonical": APP_DATA_DIR / "carefinder_hospital_procedures.csv",
        "procedures": APP_DATA_DIR / "carefinder_procedures.csv",
        "hospitals": APP_DATA_DIR / "carefinder_hospitals.csv",
        "summary": OUTPUT_DIR / "carefinder_backend_summary.md",
    }

    canonical.to_csv(paths["canonical"], index=False)
    procedures.to_csv(paths["procedures"], index=False)
    hospitals.to_csv(paths["hospitals"], index=False)
    write_summary(canonical, procedures, hospitals, primary_source, paths)

    LOGGER.info("Wrote %s", relative(paths["canonical"]))
    LOGGER.info("Wrote %s", relative(paths["procedures"]))
    LOGGER.info("Wrote %s", relative(paths["hospitals"]))
    return paths


def build_carefinder_dataset() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, Path]:
    primary_source = select_primary_source()
    primary_panel = load_primary_panel(primary_source)
    collapsed_panel = collapse_duplicate_primary_rows(primary_panel)
    latest_panel = select_latest_hospital_procedure_rows(collapsed_panel)

    hospital_info = load_hospital_info()
    hospital_analysis = load_hospital_analysis()
    medicare_location = load_medicare_location_fallback()

    enriched = enrich_panel(latest_panel, hospital_info, hospital_analysis, medicare_location)
    priced = compute_estimated_cost(enriched)
    ranked = compute_rank_fields(priced)
    canonical = ensure_output_columns(ranked)
    procedures = make_procedure_lookup(canonical)
    hospitals = make_hospital_lookup(canonical)

    return canonical, procedures, hospitals, primary_source


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    canonical, procedures, hospitals, primary_source = build_carefinder_dataset()
    write_outputs(canonical, procedures, hospitals, primary_source)

    LOGGER.info(
        "CareFinder build complete: %s hospital-procedure rows, %s procedures, %s hospitals.",
        len(canonical),
        len(procedures),
        len(hospitals),
    )


if __name__ == "__main__":
    main()
