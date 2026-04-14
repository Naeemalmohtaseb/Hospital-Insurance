# CareFinder Backend Data Preparation

CareFinder is a concept app layer for comparing hospitals by procedure, cost, quality, and later distance. This backend prepares local project data into frontend-ready CSV files without using web APIs, OCR, mock data, or moving any original datasets.

## What This Backend Does

The pipeline creates one canonical hospital x procedure table plus lookup tables for procedures and hospitals. It is designed for a future React frontend that can filter by procedure, state, and hospital name, then rank hospitals using cost and quality fields.

The backend has two scripts:

- `scripts/inspect_carefinder_sources.py` inventories relevant local files under `Data/` and writes a source-selection artifact.
- `scripts/build_carefinder_dataset.py` builds the app-ready CareFinder data tables.

## Source Strategy

The build script prefers cleaned merged sources over raw extracts. The current source strategy is:

- Primary hospital-procedure panel: `Data/thesis_merged_with_turquoise.csv`
- Hospital address and quality enrichment: `Data/Hospital_General_Information.csv.xlsx`
- Hospital-level analytic ratios: `Data/analysis_hospital_level_ready.csv`
- Location fallback: `Data/medicare_core_clean.csv`, then other Medicare core variants if needed

The raw `Data/Insurance.csv` file is not read by the build script because it is very large and too raw for the app layer. Its cleaned Turquoise DRG outputs are used instead.

## Estimated Cost Definition

`estimated_cost` is meant to support consumer-style comparison. The builder prioritizes paid or negotiated amounts over chargemaster-style charges:

1. Turquoise `AVG_COMMERCIAL`
2. Turquoise `AVG_MEDICARE_ADVANTAGE`
3. Turquoise `AVG_MEDICARE_FFS`
4. CMS Medicare `Avg_Tot_Pymt_Amt`

The output keeps `estimated_cost_source` and `estimated_cost_source_label` so downstream UI code can tell when fallback sources were used. Gross charges and submitted charges are preserved as reference fields but are not used as the final estimated-cost fallback.

## Outputs

Run outputs are written to:

- `app/data/carefinder_hospital_procedures.csv`
- `app/data/carefinder_procedures.csv`
- `app/data/carefinder_hospitals.csv`
- `outputs/carefinder/carefinder_backend_summary.md`
- `outputs/carefinder/carefinder_source_inventory.csv`
- `outputs/carefinder/carefinder_source_inventory.md`

The canonical hospital-procedure table includes stable app-facing fields such as `hospital_id`, `CCN`, `hospital_name`, `address`, `city`, `state`, `zip`, `procedure_code`, `procedure_name`, `estimated_cost`, `quality_rating`, `high_quality`, `commercial_to_medicare`, `charge_to_medicare`, `has_quality`, `has_price`, `cost_score_0_100`, `quality_score_0_100`, and `value_score_base`.

## How To Rerun

From the project root:

```bash
python scripts/inspect_carefinder_sources.py
python scripts/build_carefinder_dataset.py
```

On Windows, if `python` is not on PATH but the Python launcher is available:

```bash
py scripts/inspect_carefinder_sources.py
py scripts/build_carefinder_dataset.py
```

## Major Assumptions

- One CareFinder row represents one hospital x one DRG procedure.
- If a hospital-procedure appears in multiple years, the builder keeps the latest available Medicare year for that hospital-procedure pair.
- If multiple Turquoise provider IDs map to the same CCN, DRG, and year, the builder collapses those matches using median numeric price/payment fields and first non-missing descriptive fields.
- `high_quality` is derived from real hospital quality ratings using `quality_rating >= 4`.
- Cost ranking is procedure-relative: lower estimated cost gives a better cost score.
- `value_score_base` is a simple equal-weight average of cost and quality scores when both are available. Distance is intentionally left for a later geospatial step.

## Known Limitations

- Quality ratings are hospital-level, not procedure-specific.
- Latitude and longitude are blank placeholders; no external geocoding is performed.
- The procedure catalog reflects the DRG procedures available in the cleaned thesis/Turquoise merge, not every possible medical service.
- Some rows use Medicare-based cost fallbacks when commercial negotiated estimates are unavailable. The source field should be shown or respected in downstream analysis.
- Distance and user-entered location search are not implemented in this backend phase.
