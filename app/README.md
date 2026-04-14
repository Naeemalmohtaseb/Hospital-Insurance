# CareFinder React Prototype

CareFinder is a single-page React demo that reads the real prepared backend CSV files from `app/data/`.

## Data Sources

The Vite app is configured with `publicDir: "data"`, so the browser fetches these generated files directly:

- `app/data/carefinder_hospital_procedures.csv`
- `app/data/carefinder_procedures.csv`
- `app/data/carefinder_hospitals.csv`

No mock records are used.

## Run Locally

From the `app/` folder:

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Notes

- `estimated_cost` comes from the documented backend fallback hierarchy and the UI displays the source label.
- Missing hospital ratings are displayed as missing, not filled.
- Version 1 does not calculate distance or route time. Location fields are present for a later geospatial step.
- This is a comparison demo, not medical advice.
