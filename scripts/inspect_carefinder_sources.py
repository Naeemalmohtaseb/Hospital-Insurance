"""Inspect local project data sources for the CareFinder backend.

This script deliberately inventories likely app inputs instead of making the
CareFinder build pipeline scan every raw file each time it runs.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "Data"
OUTPUT_DIR = PROJECT_ROOT / "outputs" / "carefinder"

SUPPORTED_EXTENSIONS = {".csv", ".xlsx", ".xls", ".parquet"}
SKIP_DIR_NAMES = {"delete", "scrap data"}
RELEVANT_PATH_KEYWORDS = (
    "analysis",
    "hospital",
    "insurance",
    "medicare",
    "provider",
    "thesis",
    "turquoise",
)

SAMPLE_ROWS = 100
MAX_CSV_ROWCOUNT_BYTES = 800 * 1024 * 1024
MAX_EXCEL_ROWCOUNT_BYTES = 75 * 1024 * 1024

LOGGER = logging.getLogger("carefinder.inspect")


@dataclass
class SourceSummary:
    file_name: str
    relative_path: str
    file_size_mb: float
    rows: str
    columns: int
    likely_level: str
    likely_purpose: str
    usefulness_for_carefinder: str
    contains_hospital_id: bool
    contains_hospital_name: bool
    contains_location_fields: bool
    contains_procedure_fields: bool
    contains_usable_price_field: bool
    contains_usable_quality_field: bool
    notes: str
    column_names: str


def normalize_column_name(column: str) -> str:
    """Normalize column names for heuristic matching."""
    return re.sub(r"[^a-z0-9]+", " ", str(column).lower()).strip()


def has_signal(columns: Iterable[str], patterns: Iterable[str]) -> bool:
    normalized = [normalize_column_name(col) for col in columns]
    return any(any(re.search(pattern, col) for pattern in patterns) for col in normalized)


def matching_columns(columns: Iterable[str], patterns: Iterable[str]) -> list[str]:
    matches: list[str] = []
    for column in columns:
        normalized = normalize_column_name(column)
        if any(re.search(pattern, normalized) for pattern in patterns):
            matches.append(str(column))
    return matches


SIGNAL_PATTERNS = {
    "hospital_id": (r"\bccn\b", r"facility id", r"rndrng prvdr ccn"),
    "hospital_name": (r"facility name", r"hospital name", r"provider name", r"org name"),
    "location": (
        r"\baddress\b",
        r"\bcity\b",
        r"city town",
        r"\bstate\b",
        r"\bzip\b",
        r"zip5",
        r"county",
        r"prvdr st\b",
    ),
    "procedure": (r"\bdrg\b", r"procedure", r"ms drg"),
    "price": (
        r"avg commercial",
        r"commercial to medicare",
        r"charge to medicare",
        r"ma to medicare",
        r"gap charge",
        r"negotiated",
        r"payment",
        r"pymt",
        r"gross charge",
        r"covered charge",
        r"submtd.*chrg",
        r"medicare rate",
        r"avg medicare",
        r"avg tot",
        r"avg mdcr",
    ),
    "quality": (r"overall rating", r"rating num", r"high quality", r"measure count"),
}


def is_relevant_file(path: Path) -> bool:
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        return False

    rel_parts = [part.lower() for part in path.relative_to(DATA_DIR).parts]
    if any(part in SKIP_DIR_NAMES for part in rel_parts):
        return False

    if path.parent == DATA_DIR:
        return True

    rel_text = str(path.relative_to(DATA_DIR)).lower()
    return any(keyword in rel_text for keyword in RELEVANT_PATH_KEYWORDS)


def find_relevant_files() -> list[Path]:
    if not DATA_DIR.exists():
        raise FileNotFoundError(f"Data directory not found: {DATA_DIR}")

    return sorted(path for path in DATA_DIR.rglob("*") if path.is_file() and is_relevant_file(path))


def count_csv_rows(path: Path) -> str:
    if path.stat().st_size > MAX_CSV_ROWCOUNT_BYTES:
        return f"not counted (>{MAX_CSV_ROWCOUNT_BYTES // (1024 * 1024)} MB)"

    line_count = 0
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            line_count += block.count(b"\n")
    return str(max(line_count - 1, 0))


def count_excel_rows(path: Path) -> str:
    if path.stat().st_size > MAX_EXCEL_ROWCOUNT_BYTES:
        return f"not counted (>{MAX_EXCEL_ROWCOUNT_BYTES // (1024 * 1024)} MB)"

    try:
        import openpyxl

        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        sheet = workbook.active
        return str(max(sheet.max_row - 1, 0))
    except Exception as exc:  # pragma: no cover - depends on local Excel engine
        LOGGER.warning("Could not count Excel rows for %s: %s", path.name, exc)
        return "not counted"


def read_sample(path: Path) -> tuple[pd.DataFrame, str]:
    suffix = path.suffix.lower()
    notes: list[str] = []

    if suffix == ".csv":
        sample = pd.read_csv(path, nrows=SAMPLE_ROWS, dtype=str, low_memory=False)
        rows = count_csv_rows(path)
        if rows.startswith("not counted"):
            notes.append("row count skipped to avoid scanning a very large raw file")
        return sample, rows

    if suffix in {".xlsx", ".xls"}:
        sample = pd.read_excel(path, nrows=SAMPLE_ROWS, dtype=str)
        return sample, count_excel_rows(path)

    if suffix == ".parquet":
        try:
            sample = pd.read_parquet(path)
            return sample.head(SAMPLE_ROWS), str(len(sample))
        except Exception as exc:
            empty_note = "empty or unreadable parquet file" if path.stat().st_size == 0 else "unreadable parquet file"
            LOGGER.warning("Could not read parquet %s: %s", path.name, exc)
            return pd.DataFrame(), empty_note

    return pd.DataFrame(), "unsupported"


def infer_level(columns: list[str]) -> str:
    has_hospital_id_col = has_signal(columns, SIGNAL_PATTERNS["hospital_id"])
    has_hospital_name_col = has_signal(columns, SIGNAL_PATTERNS["hospital_name"])
    has_procedure_col = has_signal(columns, SIGNAL_PATTERNS["procedure"])
    has_location_col = has_signal(columns, SIGNAL_PATTERNS["location"])
    has_price_col = has_signal(columns, SIGNAL_PATTERNS["price"])
    has_quality_col = has_signal(columns, SIGNAL_PATTERNS["quality"])

    if (has_hospital_id_col or has_hospital_name_col) and has_procedure_col:
        return "hospital-procedure"
    if (has_hospital_id_col or has_hospital_name_col) and has_location_col and has_quality_col:
        return "hospital"
    if (has_hospital_id_col or has_hospital_name_col) and (has_price_col or has_quality_col):
        return "hospital"
    if has_procedure_col and has_price_col:
        return "procedure-price"
    if has_location_col and not (has_hospital_id_col or has_hospital_name_col):
        return "geography/covariate"
    return "unclear"


def infer_purpose(path: Path, columns: list[str]) -> str:
    name = path.name.lower()
    rel = str(path.relative_to(DATA_DIR)).lower()

    if name == "thesis_merged_with_turquoise.csv":
        return "cleaned hospital-DRG analytic panel enriched with Turquoise negotiated-price fields"
    if name.startswith("analysis_hospital_level"):
        return "hospital-level cleaned analytic summary with quality and price ratios"
    if name == "hospital_general_information.csv.xlsx":
        return "CMS hospital lookup with address, ownership, emergency services, and star rating"
    if name == "turquoise_drg_panel.csv":
        return "Turquoise DRG-level provider price panel"
    if name == "turquoise_provider_ccn_map.csv":
        return "crosswalk from Turquoise provider IDs to CMS CCNs"
    if name.startswith("medicare_core"):
        return "cleaned Medicare hospital-DRG payment panel"
    if "medicare" in rel:
        return "raw or intermediate Medicare DRG payment source"
    if name == "insurance.csv":
        return "very large raw insurance price extract; useful upstream but too raw for app reads"
    if "cost" in rel or "wage" in rel or "hosp10" in rel:
        return "cost or wage covariate source, likely not needed for the first app-facing table"
    if has_signal(columns, SIGNAL_PATTERNS["quality"]):
        return "hospital quality source"
    if has_signal(columns, SIGNAL_PATTERNS["price"]):
        return "price source"
    return "supporting or unclear source"


def infer_usefulness(path: Path, columns: list[str], rows: str) -> str:
    name = path.name.lower()
    score = 0

    if has_signal(columns, SIGNAL_PATTERNS["hospital_id"]):
        score += 2
    if has_signal(columns, SIGNAL_PATTERNS["hospital_name"]):
        score += 1
    if has_signal(columns, SIGNAL_PATTERNS["location"]):
        score += 2
    if has_signal(columns, SIGNAL_PATTERNS["procedure"]):
        score += 2
    if has_signal(columns, SIGNAL_PATTERNS["price"]):
        score += 2
    if has_signal(columns, SIGNAL_PATTERNS["quality"]):
        score += 2

    if any(token in name for token in ("merged", "ready", "clean")):
        score += 1
    if "sample" in name:
        score -= 2
    if rows.startswith("not counted") and path.stat().st_size > 2 * 1024 * 1024 * 1024:
        score -= 2

    if score >= 9:
        return "high"
    if score >= 6:
        return "medium-high"
    if score >= 3:
        return "medium"
    return "low"


def summarize_source(path: Path) -> SourceSummary:
    try:
        sample, rows = read_sample(path)
        columns = [str(column) for column in sample.columns]
        notes: list[str] = []
        if not columns:
            notes.append("no readable columns found")
        if rows.startswith("not counted") or "unreadable" in rows or "empty" in rows:
            notes.append(rows)

        price_matches = matching_columns(columns, SIGNAL_PATTERNS["price"])
        quality_matches = matching_columns(columns, SIGNAL_PATTERNS["quality"])
        location_matches = matching_columns(columns, SIGNAL_PATTERNS["location"])

        if price_matches:
            notes.append("price-like columns: " + ", ".join(price_matches[:5]))
        if quality_matches:
            notes.append("quality-like columns: " + ", ".join(quality_matches[:5]))
        if location_matches:
            notes.append("location-like columns: " + ", ".join(location_matches[:5]))

        return SourceSummary(
            file_name=path.name,
            relative_path=str(path.relative_to(PROJECT_ROOT)),
            file_size_mb=round(path.stat().st_size / (1024 * 1024), 2),
            rows=rows,
            columns=len(columns),
            likely_level=infer_level(columns),
            likely_purpose=infer_purpose(path, columns),
            usefulness_for_carefinder=infer_usefulness(path, columns, rows),
            contains_hospital_id=has_signal(columns, SIGNAL_PATTERNS["hospital_id"]),
            contains_hospital_name=has_signal(columns, SIGNAL_PATTERNS["hospital_name"]),
            contains_location_fields=has_signal(columns, SIGNAL_PATTERNS["location"]),
            contains_procedure_fields=has_signal(columns, SIGNAL_PATTERNS["procedure"]),
            contains_usable_price_field=has_signal(columns, SIGNAL_PATTERNS["price"]),
            contains_usable_quality_field=has_signal(columns, SIGNAL_PATTERNS["quality"]),
            notes="; ".join(notes),
            column_names=", ".join(columns),
        )
    except Exception as exc:
        LOGGER.warning("Could not summarize %s: %s", path, exc)
        return SourceSummary(
            file_name=path.name,
            relative_path=str(path.relative_to(PROJECT_ROOT)),
            file_size_mb=round(path.stat().st_size / (1024 * 1024), 2),
            rows="not read",
            columns=0,
            likely_level="unreadable",
            likely_purpose="unreadable source",
            usefulness_for_carefinder="low",
            contains_hospital_id=False,
            contains_hospital_name=False,
            contains_location_fields=False,
            contains_procedure_fields=False,
            contains_usable_price_field=False,
            contains_usable_quality_field=False,
            notes=str(exc),
            column_names="",
        )


def markdown_escape(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def write_markdown(summaries: list[SourceSummary], output_path: Path) -> None:
    rows = sorted(
        summaries,
        key=lambda item: (
            {"high": 0, "medium-high": 1, "medium": 2, "low": 3}.get(item.usefulness_for_carefinder, 9),
            item.relative_path,
        ),
    )
    headers = [
        "file",
        "rows",
        "cols",
        "level",
        "usefulness",
        "location",
        "price",
        "quality",
        "likely purpose / notes",
    ]
    lines = [
        "# CareFinder Source Inventory",
        "",
        "Generated by `scripts/inspect_carefinder_sources.py` from local files under `Data/`.",
        "",
        "|" + "|".join(headers) + "|",
        "|" + "|".join(["---"] * len(headers)) + "|",
    ]
    for item in rows:
        purpose_notes = item.likely_purpose
        if item.notes:
            purpose_notes = f"{purpose_notes}. {item.notes}"
        lines.append(
            "|"
            + "|".join(
                [
                    markdown_escape(item.relative_path),
                    markdown_escape(item.rows),
                    markdown_escape(item.columns),
                    markdown_escape(item.likely_level),
                    markdown_escape(item.usefulness_for_carefinder),
                    "yes" if item.contains_location_fields else "no",
                    "yes" if item.contains_usable_price_field else "no",
                    "yes" if item.contains_usable_quality_field else "no",
                    markdown_escape(purpose_notes),
                ]
            )
            + "|"
        )

    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    LOGGER.info("Scanning relevant local files in %s", DATA_DIR)
    summaries = [summarize_source(path) for path in find_relevant_files()]

    inventory_csv = OUTPUT_DIR / "carefinder_source_inventory.csv"
    inventory_md = OUTPUT_DIR / "carefinder_source_inventory.md"

    pd.DataFrame([summary.__dict__ for summary in summaries]).to_csv(inventory_csv, index=False)
    write_markdown(summaries, inventory_md)

    LOGGER.info("Wrote %s", inventory_csv.relative_to(PROJECT_ROOT))
    LOGGER.info("Wrote %s", inventory_md.relative_to(PROJECT_ROOT))
    LOGGER.info("Inspected %s relevant source files.", len(summaries))


if __name__ == "__main__":
    main()
