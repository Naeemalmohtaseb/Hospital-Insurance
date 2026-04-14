# CareFinder React Prototype

CareFinder is a single-page React demo that reads the real prepared backend CSV files from `app/public/data/`.

## Data Sources

Vite serves files in `public/` from the site root, so the browser fetches these files directly:

- `/data/carefinder_hospital_procedures.csv`
- `/data/carefinder_procedures.csv`
- `/data/carefinder_hospitals.csv`

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
