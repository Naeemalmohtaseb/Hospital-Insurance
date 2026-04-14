import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  HeartPulse,
  Info,
  MapPin,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Progress } from "./components/ui/progress";
import { Select } from "./components/ui/select";
import { HospitalProcedure, ProcedureOption, loadCareFinderData } from "./lib/data";
import { clamp, formatCurrency, formatNumber } from "./lib/utils";

type SortMode = "value" | "cost" | "quality" | "alphabetical";

type ScoredHospital = HospitalProcedure & {
  costScore: number;
  costPercentile: number;
  qualityScore: number;
  confidenceScore: number;
  valueScore: number;
  interpretation: string;
  badgeLabels: string[];
  outsideCurrentFilters?: boolean;
};

type Filters = {
  procedureCode: string;
  state: string;
  city: string;
  zip: string;
  hospital: string;
  minQuality: string;
  includeMissingRatings: boolean;
  sortMode: SortMode;
};

const defaultFilters: Filters = {
  procedureCode: "",
  state: "",
  city: "",
  zip: "",
  hospital: "",
  minQuality: "any",
  includeMissingRatings: true,
  sortMode: "value",
};

const sourceShortLabels: Record<string, string> = {
  avg_commercial: "Commercial estimate",
  avg_medicare_advantage: "Medicare Advantage",
  avg_medicare_ffs: "Medicare FFS",
  medicare_total_payment: "Medicare payment",
};

const sourceDetailLabels: Record<string, string> = {
  avg_commercial:
    "What private insurance plans negotiate with hospitals. Usually the closest source here to a real-world price.",
  avg_medicare_advantage:
    "Private plans that replace traditional Medicare. Prices vary and are less consistent in this dataset.",
  avg_medicare_ffs:
    "The standard government fee-for-service pricing model. Use it as a baseline reference price.",
  medicare_total_payment:
    "What Medicare paid hospitals on average. It is often lower than private insurance and is used here as a fallback.",
};

const VALUE_SCORE_WEIGHT = {
  cost: 0.7,
  quality: 0.3,
} as const;

const EQUAL_COST_SCORE = 75;
const MISSING_QUALITY_SCORE = 35;
const MISSING_QUALITY_VALUE_PENALTY = 10;
const LOW_RATING_THRESHOLD = 2;
const LOW_RATING_VALUE_PENALTY = 24;
const VERY_LOW_RATING_VALUE_PENALTY = 32;
const EXPENSIVE_COST_PERCENTILE = 0.75;
const EXPENSIVE_COST_VALUE_PENALTY = 8;
const STRONGEST_COST_SOURCE = "avg_commercial";
const BASE_CONFIDENCE_SCORE = 94;
const MISSING_RATING_CONFIDENCE_PENALTY = 30;
const UNKNOWN_SOURCE_CONFIDENCE_PENALTY = 14;
const COST_SOURCE_CONFIDENCE_PENALTY: Record<string, number> = {
  avg_commercial: 0,
  avg_medicare_advantage: 8,
  avg_medicare_ffs: 16,
  medicare_total_payment: 20,
};

function compareKey(row: HospitalProcedure) {
  return `${row.hospitalId}-${row.procedureCode}`;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function procedureLabel(procedure?: ProcedureOption) {
  if (!procedure) {
    return "Select a procedure";
  }
  return `${procedure.procedureCode} - ${procedure.procedureName}`;
}

function quantile(values: number[], percentile: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower];
  }

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function normalizedInverseCostScore(cost: number | null, minCost: number, maxCost: number) {
  if (cost === null || !Number.isFinite(cost)) {
    return 0;
  }
  if (maxCost === minCost) {
    return EQUAL_COST_SCORE;
  }
  return clamp((1 - (cost - minCost) / (maxCost - minCost)) * 100);
}

function costPercentile(cost: number | null, minCost: number, maxCost: number) {
  if (cost === null || !Number.isFinite(cost) || maxCost === minCost) {
    return 0.5;
  }
  return clamp((cost - minCost) / (maxCost - minCost), 0, 1);
}

function qualityScoreFromRating(rating: number | null) {
  if (rating === null || !Number.isFinite(rating)) {
    return MISSING_QUALITY_SCORE;
  }
  return clamp((rating / 5) * 100);
}

function valuePenalty(rating: number | null, isExpensiveQuartile: boolean) {
  let penalty = isExpensiveQuartile ? EXPENSIVE_COST_VALUE_PENALTY : 0;

  if (rating === null || !Number.isFinite(rating)) {
    return penalty + MISSING_QUALITY_VALUE_PENALTY;
  }

  if (rating <= 1) {
    return penalty + VERY_LOW_RATING_VALUE_PENALTY;
  }

  if (rating <= LOW_RATING_THRESHOLD) {
    return penalty + LOW_RATING_VALUE_PENALTY;
  }

  return penalty;
}

function confidenceScoreFor(row: HospitalProcedure) {
  const hasRating = row.qualityRating !== null && Number.isFinite(row.qualityRating);
  const sourcePenalty =
    COST_SOURCE_CONFIDENCE_PENALTY[row.estimatedCostSource] ?? UNKNOWN_SOURCE_CONFIDENCE_PENALTY;
  const ratingPenalty = hasRating ? 0 : MISSING_RATING_CONFIDENCE_PENALTY;

  return clamp(BASE_CONFIDENCE_SCORE - sourcePenalty - ratingPenalty, 0, 100);
}

function scoreRows(rows: HospitalProcedure[]): ScoredHospital[] {
  if (rows.length === 0) {
    return [];
  }

  const costs = rows
    .map((row) => row.estimatedCost)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (costs.length === 0) {
    return rows.map((row) => ({
      ...row,
      costScore: 0,
      costPercentile: 0.5,
      qualityScore: qualityScoreFromRating(row.qualityRating),
      confidenceScore: confidenceScoreFor(row),
      valueScore: 0,
      interpretation: interpretationFor(0.5, row.qualityRating),
      badgeLabels: row.qualityRating === null ? ["Rating unavailable"] : [],
    }));
  }

  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const expensiveCostCutoff = quantile(costs, EXPENSIVE_COST_PERCENTILE) ?? maxCost;

  const scored = rows.map((row) => {
    const costScore = normalizedInverseCostScore(row.estimatedCost, minCost, maxCost);
    const rowCostPercentile = costPercentile(row.estimatedCost, minCost, maxCost);
    const qualityScore = qualityScoreFromRating(row.qualityRating);
    const isExpensiveQuartile =
      row.estimatedCost !== null &&
      Number.isFinite(row.estimatedCost) &&
      row.estimatedCost >= expensiveCostCutoff;
    const penalty = valuePenalty(row.qualityRating, isExpensiveQuartile);
    const confidenceScore = confidenceScoreFor(row);
    const valueScore = clamp(
      costScore * VALUE_SCORE_WEIGHT.cost + qualityScore * VALUE_SCORE_WEIGHT.quality - penalty,
    );

    return {
      ...row,
      costScore,
      costPercentile: rowCostPercentile,
      qualityScore,
      confidenceScore,
      valueScore,
      interpretation: interpretationFor(rowCostPercentile, row.qualityRating),
      badgeLabels: [] as string[],
    };
  });

  const bestValue = Math.max(...scored.map((row) => row.valueScore));
  const lowestCost = Math.min(...scored.map((row) => row.estimatedCost ?? Number.POSITIVE_INFINITY));
  const highestQuality = Math.max(
    ...scored.map((row) => row.qualityRating ?? Number.NEGATIVE_INFINITY),
  );

  return scored.map((row) => ({
    ...row,
    badgeLabels: [
      row.valueScore === bestValue ? "Top value estimate" : "",
      row.estimatedCost === lowestCost ? "Lowest estimated cost" : "",
      row.qualityRating !== null && row.qualityRating === highestQuality ? "Highest rating" : "",
      row.qualityRating === null ? "Rating unavailable" : "",
    ].filter(Boolean),
  }));
}

function interpretationFor(rowCostPercentile: number, rating: number | null) {
  const lowCost = rowCostPercentile <= 0.25;
  const highCost = rowCostPercentile >= EXPENSIVE_COST_PERCENTILE;

  if (rating === null || !Number.isFinite(rating)) {
    return "Estimated cost available. No rating data.";
  }

  if (rating <= LOW_RATING_THRESHOLD && lowCost) {
    return "Lower cost, but weaker rating.";
  }

  if (rating <= LOW_RATING_THRESHOLD) {
    return "Weaker rating for this filtered set.";
  }

  if (rating >= 4 && highCost) {
    return "Higher rating, but more expensive.";
  }

  if (rating >= 4 && lowCost) {
    return "Lower cost with a higher rating.";
  }

  if (lowCost) {
    return "Lower cost than most filtered options.";
  }

  if (highCost) {
    return "Higher estimated cost than most filtered options.";
  }

  if (rating >= 4) {
    return "Higher rating with a mid-range estimated cost.";
  }

  return "Mid-range estimated cost and average rating.";
}

function sortRows(rows: ScoredHospital[], sortMode: SortMode) {
  return [...rows].sort((a, b) => {
    if (sortMode === "cost") {
      return (a.estimatedCost ?? Number.POSITIVE_INFINITY) - (b.estimatedCost ?? Number.POSITIVE_INFINITY);
    }
    if (sortMode === "quality") {
      return (b.qualityRating ?? -1) - (a.qualityRating ?? -1);
    }
    if (sortMode === "alphabetical") {
      return a.hospitalName.localeCompare(b.hospitalName);
    }
    return b.valueScore - a.valueScore;
  });
}

function costStandingNoteFor(row: ScoredHospital) {
  if (row.costPercentile >= EXPENSIVE_COST_PERCENTILE) {
    return "This is in the higher-cost group.";
  }
  return "Higher means lower cost within these results.";
}

function qualityStandingNoteFor(row: ScoredHospital) {
  if (row.qualityRating === null || !Number.isFinite(row.qualityRating)) {
    return "No rating is available.";
  }
  if (row.qualityRating <= LOW_RATING_THRESHOLD) {
    return "Low ratings lower the estimate a lot.";
  }
  return "Uses the hospital's overall rating.";
}

function confidenceNoteFor(row: ScoredHospital) {
  const ratingMissing = row.qualityRating === null || !Number.isFinite(row.qualityRating);
  const fallbackSource = row.estimatedCostSource !== STRONGEST_COST_SOURCE;

  if (ratingMissing && fallbackSource) {
    return "Lower because the rating is missing and the price uses a fallback source.";
  }
  if (ratingMissing) {
    return "Lower because the rating is missing.";
  }
  if (fallbackSource) {
    return "Lower because the price uses a fallback source.";
  }
  return "Higher because a rating and commercial estimate are both present.";
}

function sourceLabelFor(row: HospitalProcedure) {
  const normalizedSource = row.estimatedCostSource.trim().toLowerCase();
  return (
    sourceShortLabels[normalizedSource] ||
    row.estimatedCostSourceLabel ||
    "Source unavailable"
  );
}

function sourceDetailFor(row: HospitalProcedure) {
  const normalizedSource = row.estimatedCostSource.trim().toLowerCase();
  return (
    sourceDetailLabels[normalizedSource] ||
    row.estimatedCostSourceLabel ||
    "Source detail is not available for this estimate."
  );
}

function ratingLabel(rating: number | null) {
  return rating === null || !Number.isFinite(rating) ? "No rating available" : `${rating.toFixed(1)} / 5`;
}

function scoreLabel(score: number) {
  return `${formatNumber(score, 0)} / 100`;
}

export default function App() {
  const [rows, setRows] = useState<HospitalProcedure[]>([]);
  const [procedures, setProcedures] = useState<ProcedureOption[]>([]);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedDetail, setSelectedDetail] = useState<ScoredHospital | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareExpanded, setCompareExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    loadCareFinderData()
      .then((data) => {
        setRows(data.rows);
        setProcedures(data.procedures);
        const defaultProcedure =
          data.procedures.find((procedure) => procedure.procedureCode === "470") ?? data.procedures[0];
        setFilters((current) => ({
          ...current,
          procedureCode: defaultProcedure?.procedureCode ?? "",
        }));
      })
      .catch((error: Error) => {
        setLoadError(error.message);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const procedureByCode = useMemo(() => {
    return new Map(procedures.map((procedure) => [procedure.procedureCode, procedure]));
  }, [procedures]);

  const selectedProcedure = procedureByCode.get(filters.procedureCode);

  const rowsForProcedure = useMemo(() => {
    return rows.filter((row) => row.procedureCode === filters.procedureCode);
  }, [filters.procedureCode, rows]);

  const stateOptions = useMemo(() => {
    return Array.from(new Set(rowsForProcedure.map((row) => row.state).filter(Boolean))).sort();
  }, [rowsForProcedure]);

  const filteredRows = useMemo(() => {
    const city = normalizeSearch(filters.city);
    const zip = normalizeSearch(filters.zip);
    const hospital = normalizeSearch(filters.hospital);
    const minQuality = filters.minQuality === "any" ? null : Number(filters.minQuality);

    return rowsForProcedure.filter((row) => {
      const hasQuality = row.qualityRating !== null;
      if (filters.state && row.state !== filters.state) {
        return false;
      }
      if (city && !row.city.toLowerCase().includes(city)) {
        return false;
      }
      if (zip && !row.zip.toLowerCase().startsWith(zip)) {
        return false;
      }
      if (hospital && !row.hospitalName.toLowerCase().includes(hospital)) {
        return false;
      }
      if (!filters.includeMissingRatings && !hasQuality) {
        return false;
      }
      if (minQuality !== null && (!hasQuality || row.qualityRating! < minQuality)) {
        return false;
      }
      return true;
    });
  }, [filters, rowsForProcedure]);

  const scoredRows = useMemo(() => {
    return sortRows(scoreRows(filteredRows), filters.sortMode);
  }, [filteredRows, filters.sortMode]);

  const comparedRows = useMemo(() => {
    const byId = new Map(scoredRows.map((row) => [compareKey(row), row]));
    const fallbackById = new Map(
      scoreRows(rows.filter((row) => compareIds.includes(compareKey(row)))).map((row) => [
        compareKey(row),
        row,
      ]),
    );

    return compareIds
      .map((id) => {
        const visibleRow = byId.get(id);
        if (visibleRow) {
          return visibleRow;
        }
        const fallbackRow = fallbackById.get(id);
        return fallbackRow ? { ...fallbackRow, outsideCurrentFilters: true } : null;
      })
      .filter((row): row is ScoredHospital => Boolean(row));
  }, [compareIds, rows, scoredRows]);

  useEffect(() => {
    if (comparedRows.length === 0) {
      setCompareExpanded(false);
    }
  }, [comparedRows.length]);

  const sourceChartData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of scoredRows) {
      const label = sourceLabelFor(row);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts, ([source, count]) => ({ source, count }));
  }, [scoredRows]);

  function updateFilter<Key extends keyof Filters>(key: Key, value: Filters[Key]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function toggleCompare(row: ScoredHospital) {
    const id = compareKey(row);
    setCompareIds((current) => {
      if (current.includes(id)) {
        return current.filter((item) => item !== id);
      }
      setCompareExpanded(true);
      return [...current, id];
    });
  }

  const activeFilterCount = [
    filters.state,
    filters.city,
    filters.zip,
    filters.hospital,
    filters.minQuality !== "any" ? filters.minQuality : "",
    !filters.includeMissingRatings ? "rated only" : "",
  ].filter(Boolean).length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className={comparedRows.length > 0 ? (compareExpanded ? "pb-[28rem]" : "pb-20") : undefined}>
        <Hero
          filters={filters}
          procedures={procedures}
          selectedProcedure={selectedProcedure}
          stateOptions={stateOptions}
          isLoading={isLoading}
          updateFilter={updateFilter}
        />

        <section id="compare" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          {loadError ? (
            <EmptyState
              title="The CareFinder data could not be loaded"
              text={loadError}
            />
          ) : (
            <>
              <SummaryBar
                selectedProcedure={selectedProcedure}
                resultCount={scoredRows.length}
                activeFilterCount={activeFilterCount}
                isLoading={isLoading}
              />

              <div className="mt-6">
                <div className="space-y-4">
                  {isLoading ? (
                    <LoadingCards />
                  ) : !filters.procedureCode ? (
                    <EmptyState
                      title="Select a procedure to start"
                      text="Choose one procedure group, then narrow the results by state, city, ZIP, hospital name, or rating."
                    />
                  ) : scoredRows.length === 0 ? (
                    <EmptyState
                      title="No hospitals match those filters"
                      text="Try broadening the city, ZIP, state, or rating filters while keeping the procedure selected."
                    />
                  ) : (
                    scoredRows.slice(0, 80).map((row, index) => (
                      <HospitalCard
                        key={compareKey(row)}
                        row={row}
                        rank={index + 1}
                        isCompared={compareIds.includes(compareKey(row))}
                        onCompare={() => toggleCompare(row)}
                        onDetails={() => setSelectedDetail(row)}
                      />
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        <AboutSection sourceChartData={sourceChartData} />
        <Method />
      </main>

      <DetailDrawer row={selectedDetail} onClose={() => setSelectedDetail(null)} />
      <AnimatePresence>
        {comparedRows.length > 0 && (
          <CompareTray
            rows={comparedRows}
            isExpanded={compareExpanded}
            onToggle={() => setCompareExpanded((current) => !current)}
            onRemove={(id) => {
              setCompareIds((current) => current.filter((item) => item !== id));
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="#" className="flex items-center gap-3" aria-label="CareFinder home">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white">
            <HeartPulse className="h-5 w-5" />
          </span>
          <span>
            <span className="block text-base font-semibold text-neutral-950">CareFinder</span>
            <span className="block text-xs text-neutral-500">Hospital comparison demo</span>
          </span>
        </a>
        <nav className="hidden items-center gap-2 md:flex">
          {[
            { label: "Search", href: "#search" },
            { label: "Compare", href: "#compare" },
            { label: "About", href: "#about" },
            { label: "Method", href: "#method" },
          ].map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
            >
              {item.label}
            </a>
          ))}
          <Badge variant="teal">Concept Demo</Badge>
        </nav>
      </div>
    </header>
  );
}

type HeroProps = {
  filters: Filters;
  procedures: ProcedureOption[];
  selectedProcedure?: ProcedureOption;
  stateOptions: string[];
  isLoading: boolean;
  updateFilter: <Key extends keyof Filters>(key: Key, value: Filters[Key]) => void;
};

function Hero({
  filters,
  procedures,
  selectedProcedure,
  stateOptions,
  isLoading,
  updateFilter,
}: HeroProps) {
  return (
    <section id="search" className="hero-image relative min-h-[78vh] overflow-hidden border-b border-border">
      <div className="absolute inset-0 bg-[#f8fcfb]/90" />
      <div className="relative mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 lg:px-8">
        <div className="max-w-3xl pt-8">
          <Badge variant="teal">Concept Demo</Badge>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight text-neutral-950 sm:text-5xl">
            Compare hospitals for a procedure
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-neutral-700">
            Pick a procedure. Filter by place. See the estimated cost, hospital rating, and price source.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-white/95 p-4 shadow-soft sm:p-5">
          <div className="mb-4 flex flex-col justify-between gap-3 border-b border-border pb-4 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-semibold text-neutral-950">Start with a procedure</p>
              <p className="mt-1 text-sm text-neutral-600">
                {isLoading
                  ? "Loading prepared CareFinder data..."
                  : `${procedures.length} procedure groups are available in this dataset.`}
              </p>
            </div>
            <Badge variant="blue">
              {selectedProcedure ? procedureLabel(selectedProcedure) : isLoading ? "Awaiting data" : "No procedures loaded"}
            </Badge>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Procedure">
              <Select
                value={filters.procedureCode}
                onChange={(event) => updateFilter("procedureCode", event.target.value)}
              >
                {procedures.length === 0 && <option value="">No procedures loaded</option>}
                {procedures.map((procedure) => (
                  <option key={procedure.procedureCode} value={procedure.procedureCode}>
                    {procedure.procedureCode} - {procedure.procedureName}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="State">
              <Select value={filters.state} onChange={(event) => updateFilter("state", event.target.value)}>
                <option value="">All states</option>
                {stateOptions.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="City">
              <Input
                value={filters.city}
                placeholder="Try Dothan"
                onChange={(event) => updateFilter("city", event.target.value)}
              />
            </Field>

            <Field label="ZIP">
              <Input
                value={filters.zip}
                placeholder="Starts with..."
                inputMode="numeric"
                onChange={(event) => updateFilter("zip", event.target.value)}
              />
            </Field>

            <Field label="Hospital name">
              <Input
                value={filters.hospital}
                placeholder="Search by name"
                onChange={(event) => updateFilter("hospital", event.target.value)}
              />
            </Field>

            <Field label="Minimum rating">
              <Select
                value={filters.minQuality}
                onChange={(event) => updateFilter("minQuality", event.target.value)}
              >
                <option value="any">Any rating</option>
                <option value="3">3 stars and up</option>
                <option value="4">4 stars and up</option>
                <option value="5">5 stars only</option>
              </Select>
            </Field>

            <Field label="Sort">
              <Select
                value={filters.sortMode}
                onChange={(event) => updateFilter("sortMode", event.target.value as SortMode)}
              >
                <option value="value">Best value estimate</option>
                <option value="cost">Lowest estimated cost</option>
                <option value="quality">Highest rating</option>
                <option value="alphabetical">Alphabetical</option>
              </Select>
            </Field>

            <label className="flex min-h-10 items-center gap-3 rounded-md border border-border bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                className="h-4 w-4 accent-teal-700"
                checked={filters.includeMissingRatings}
                onChange={(event) => updateFilter("includeMissingRatings", event.target.checked)}
              />
              Include hospitals with no rating
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SummaryBar({
  selectedProcedure,
  resultCount,
  activeFilterCount,
  isLoading,
}: {
  selectedProcedure?: ProcedureOption;
  resultCount: number;
  activeFilterCount: number;
  isLoading: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-5 shadow-soft">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="teal">Selected procedure</Badge>
            <h2 className="text-xl font-semibold text-neutral-950">
              {selectedProcedure ? procedureLabel(selectedProcedure) : "Choose a procedure"}
            </h2>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-600">
            Not every hospital has the same type of price available. Each result shows the source.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Metric label="Hospitals found" value={isLoading ? "..." : formatNumber(resultCount)} />
          <Metric label="Active filters" value={formatNumber(activeFilterCount)} />
          <Metric label="Distance" value="Future step" />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-teal-700 bg-transparent px-4 py-2">
      <p className="text-xs font-semibold text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-neutral-950">{value}</p>
    </div>
  );
}

function HospitalCard({
  row,
  rank,
  isCompared,
  onCompare,
  onDetails,
}: {
  row: ScoredHospital;
  rank: number;
  isCompared: boolean;
  onCompare: () => void;
  onDetails: () => void;
}) {
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-border bg-white p-6 shadow-soft"
    >
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-2xl font-semibold leading-8 text-neutral-950">{row.hospitalName}</h3>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
            <MapPin className="h-4 w-4 text-teal-700" />
            <span>
              {row.city}, {row.state} {row.zip}
            </span>
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge variant="neutral">#{rank}</Badge>
            {row.badgeLabels.map((label) => (
              <Badge key={label} variant={label === "Rating unavailable" ? "amber" : "teal"}>
                {label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3 xl:w-[560px]">
          <CardMetric
            emphasis="primary"
            label="Estimated cost"
            value={formatCurrency(row.estimatedCost)}
          />
          <CardMetric
            label="Hospital rating"
            value={ratingLabel(row.qualityRating)}
          />
          <CardMetric
            emphasis="secondary"
            label="Overall value estimate"
            value={scoreLabel(row.valueScore)}
          />
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-4 border-t border-border pt-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-neutral-500">
            <span>Price source</span>
            <Badge variant="blue">{sourceLabelFor(row)}</Badge>
          </div>
          <p className="text-sm leading-6 text-neutral-700">{row.interpretation}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={isCompared ? "default" : "outline"} onClick={onCompare}>
            {isCompared ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Added
              </>
            ) : (
              "Compare"
            )}
          </Button>
          <Button variant="quiet" onClick={onDetails}>
            Details
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>
    </motion.article>
  );
}

function CardMetric({
  label,
  value,
  emphasis = "normal",
}: {
  label: string;
  value: string;
  emphasis?: "primary" | "normal" | "secondary";
}) {
  const valueClass =
    emphasis === "primary"
      ? "text-2xl font-semibold text-neutral-950"
      : emphasis === "secondary"
        ? "text-sm font-semibold text-neutral-800"
        : "text-lg font-semibold text-neutral-950";

  return (
    <div className="border-l-2 border-teal-700 bg-transparent py-1 pl-3">
      <p className="text-xs font-semibold text-neutral-500">{label}</p>
      <p className={`mt-1 leading-tight ${valueClass}`}>{value}</p>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-teal-700 py-1 pl-3">
      <p className="text-xs font-semibold text-neutral-500">{label}</p>
      <p className="mt-1 text-base font-semibold text-neutral-950">{value}</p>
    </div>
  );
}

function CompareTray({
  rows,
  isExpanded,
  onToggle,
  onRemove,
}: {
  rows: ScoredHospital[];
  isExpanded: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
}) {
  if (rows.length === 0) {
    return null;
  }

  const lowest = Math.min(...rows.map((row) => row.estimatedCost ?? Number.POSITIVE_INFINITY));
  const highestQuality = Math.max(...rows.map((row) => row.qualityRating ?? Number.NEGATIVE_INFINITY));
  const bestValue = Math.max(...rows.map((row) => row.valueScore));
  const hiddenChipCount = Math.max(rows.length - 2, 0);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {!isExpanded ? (
      <motion.aside
        key="compare-collapsed"
        className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-3"
        initial={{ y: 72, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 72, opacity: 0 }}
        transition={{ duration: 0.22 }}
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-3 rounded-t-lg border border-b-0 border-border bg-white/95 px-4 py-3 text-left shadow-[0_-12px_35px_rgba(15,23,42,0.14)] backdrop-blur transition-colors hover:bg-neutral-50"
          aria-expanded={false}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white">
            <ChevronUp className="h-4 w-4" />
          </span>
          <span>
            <span className="block text-sm font-semibold text-neutral-950">
              Compare ({rows.length} selected)
            </span>
            <span className="block text-xs text-neutral-600">Open selected hospitals</span>
          </span>
        </button>
      </motion.aside>
      ) : (
    <motion.aside
      key="compare-expanded"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 shadow-[0_-18px_45px_rgba(15,23,42,0.12)] backdrop-blur"
      initial={{ y: "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: "100%", opacity: 0 }}
      transition={{ duration: 0.24, ease: "easeInOut" }}
    >
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full flex-col gap-3 text-left sm:flex-row sm:items-center sm:justify-between"
          aria-expanded={true}
        >
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white">
              <ChevronDown className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-neutral-950">
                Compare ({rows.length} selected)
              </span>
              <span className="block text-xs text-neutral-600">Hide compare tray</span>
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            {rows.slice(0, 2).map((row) => (
              <Badge key={compareKey(row)} variant="neutral" className="max-w-[12rem] truncate">
                {row.hospitalName}
              </Badge>
            ))}
            {hiddenChipCount > 0 && <Badge variant="neutral">+{hiddenChipCount} more</Badge>}
          </span>
        </button>

        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22 }}
          className="overflow-hidden"
        >
          <div className="scrollbar-soft mt-4 max-h-[58vh] overflow-x-auto overflow-y-auto pb-3">
            <div className="flex w-max min-w-full gap-3">
              {rows.map((row) => (
                <motion.div
                  key={compareKey(row)}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  className="w-[min(84vw,24rem)] shrink-0 rounded-lg border border-border bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="truncate font-semibold text-neutral-950">{row.hospitalName}</h4>
                      <p className="mt-1 text-sm text-neutral-600">
                        {row.city}, {row.state}
                      </p>
                      {row.outsideCurrentFilters && (
                        <p className="mt-1 text-xs font-medium text-amber-700">
                          Outside current filters
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRemove(compareKey(row))}
                      aria-label={`Remove ${row.hospitalName} from compare`}
                    >
                      Remove
                    </Button>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <CompareDatum label="Estimated cost" value={formatCurrency(row.estimatedCost)} />
                    <CompareDatum
                      label="Rating"
                      value={ratingLabel(row.qualityRating)}
                    />
                    <CompareDatum label="Value estimate" value={scoreLabel(row.valueScore)} />
                    <CompareDatum
                      label="Source"
                      value={sourceLabelFor(row)}
                    />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {row.valueScore === bestValue && <Badge variant="teal">Top value estimate</Badge>}
                    {row.estimatedCost === lowest && <Badge variant="blue">Lowest estimated cost</Badge>}
                    {row.qualityRating !== null && row.qualityRating === highestQuality && (
                      <Badge variant="teal">Highest rating</Badge>
                    )}
                    {row.qualityRating === null && <Badge variant="amber">Rating unavailable</Badge>}
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </motion.aside>
      )}
    </AnimatePresence>
  );
}

function CompareDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-neutral-500">{label}</dt>
      <dd className="mt-1 font-medium text-neutral-950">{value}</dd>
    </div>
  );
}

function DetailDrawer({ row, onClose }: { row: ScoredHospital | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {row && (
        <motion.div
          className="fixed inset-0 z-50 bg-neutral-950/35"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.aside
            className="scrollbar-soft ml-auto h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-soft"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border pb-6">
              <div>
                <Badge variant="teal">Hospital detail</Badge>
                <h2 className="mt-3 text-2xl font-semibold text-neutral-950">{row.hospitalName}</h2>
                <p className="mt-2 text-sm leading-6 text-neutral-600">{row.fullAddress}</p>
                <p className="mt-3 text-sm leading-6 text-neutral-700">{row.interpretation}</p>
              </div>
              <Button variant="ghost" onClick={onClose} aria-label="Close details">
                <X className="h-5 w-5" />
              </Button>
            </div>

            <section className="mt-7">
              <p className="text-xs font-semibold uppercase text-neutral-500">Procedure estimate</p>
              <h3 className="mt-2 text-lg font-semibold leading-7 text-neutral-950">
                {row.procedureCode} - {row.procedureName}
              </h3>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <DetailMetric label="Estimated cost" value={formatCurrency(row.estimatedCost)} />
                <DetailMetric
                  label="Hospital rating"
                  value={ratingLabel(row.qualityRating)}
                />
                <DetailMetric label="Overall value estimate" value={scoreLabel(row.valueScore)} />
                <DetailMetric label="Data confidence" value={scoreLabel(row.confidenceScore)} />
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-2 text-xs font-medium text-neutral-500">
                <span>Price source</span>
                <Badge variant="blue">{sourceLabelFor(row)}</Badge>
              </div>
            </section>

            <div className="mt-7 grid gap-5 border-y border-border py-6 sm:grid-cols-2">
              <DetailMetric label="Hospital type" value={row.hospitalType || "Not available"} />
              <DetailMetric label="Ownership" value={row.hospitalOwnership || "Not available"} />
            </div>

            <div className="mt-7 rounded-lg border border-border p-5">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-5 w-5 text-teal-700" />
              <h3 className="font-semibold text-neutral-950">How this result was scored</h3>
              </div>
              <p className="mt-2 text-sm leading-6 text-neutral-600">
                This is a rough comparison. Cost matters most. Rating is secondary. Low ratings push
                the estimate down. Missing ratings lower confidence.
              </p>
              <div className="mt-5 space-y-4">
                <ScoreBar label="Cost position" value={row.costScore} note={costStandingNoteFor(row)} />
                <ScoreBar
                  label="Rating position"
                  value={row.qualityScore}
                  note={qualityStandingNoteFor(row)}
                />
                <ScoreBar
                  label="Data confidence"
                  value={row.confidenceScore}
                  note={confidenceNoteFor(row)}
                />
              </div>
            </div>

            <div className="mt-7 rounded-lg border border-border bg-white p-5">
              <h3 className="font-semibold text-neutral-950">Where the price comes from</h3>
              <p className="mt-2 text-sm leading-6 text-neutral-600">
                <span className="font-medium text-neutral-950">{sourceLabelFor(row)}.</span>{" "}
                {sourceDetailFor(row)}
              </p>
              <p className="mt-3 text-sm leading-6 text-neutral-600">
                Use this for comparison only. It is not a bill.
              </p>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ScoreBar({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-neutral-800">{label}</span>
        <span className="text-sm font-semibold text-neutral-950">{scoreLabel(value)}</span>
      </div>
      <Progress value={value} />
      <p className="mt-2 text-xs text-neutral-500">{note}</p>
    </div>
  );
}

function AboutSection({ sourceChartData }: { sourceChartData: Array<{ source: string; count: number }> }) {
  return (
    <section id="about" className="border-y border-border bg-white py-14">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <Badge variant="blue">About</Badge>
          <h2 className="mt-4 text-3xl font-semibold text-neutral-950">About this demo</h2>
          <p className="mt-3 text-base leading-7 text-neutral-600">
            Prices come from a mix of sources. Ratings describe the hospital overall. Distance is
            not scored yet.
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          <AboutCard
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Prices come from a mix of sources"
            text="Most results use commercial estimates. If those are missing, the app falls back to Medicare-based numbers."
          />
          <AboutCard
            icon={<Activity className="h-5 w-5" />}
            title="Ratings are hospital-level"
            text="The rating applies to the hospital overall, not the specific procedure."
          />
          <AboutCard
            icon={<MapPin className="h-5 w-5" />}
            title="Location is included, but distance is not"
            text="You can filter by city and ZIP. Travel time and routing are not built yet."
          />
        </div>

        <Card className="mt-8">
          <CardContent className="pt-6">
            <h3 className="font-semibold text-neutral-950">This is a concept</h3>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              The goal is to show how price and quality could be compared in one place. It is not a
              medical or financial recommendation tool.
            </p>
          </CardContent>
        </Card>

        <PriceSourceExplainer />

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>How prices are sourced in this dataset</CardTitle>
            <p className="text-sm leading-6 text-neutral-600">
              Most results use commercial estimates. When those are not available, Medicare-based
              values are used instead.
            </p>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sourceChartData} margin={{ left: 4, right: 12, top: 10, bottom: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d7e1de" />
                  <XAxis dataKey="source" tick={{ fontSize: 12 }} interval={0} angle={-12} textAnchor="end" />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip
                    cursor={{ fill: "#eef7f5" }}
                    contentStyle={{
                      border: "1px solid #d7e1de",
                      borderRadius: 8,
                      boxShadow: "0 12px 30px rgba(15, 23, 42, 0.1)",
                    }}
                  />
                  <Bar dataKey="count" fill="#0f766e" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function AboutCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <Card>
      <CardHeader>
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-800">
          {icon}
        </span>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-neutral-600">{text}</p>
      </CardContent>
    </Card>
  );
}

function PriceSourceExplainer() {
  const priceSources = [
    {
      title: "Commercial estimate",
      lines: [
        "What private insurance plans negotiate with hospitals.",
        "Usually the closest thing here to a real price.",
      ],
    },
    {
      title: "Medicare payment",
      lines: [
        "What Medicare actually pays hospitals.",
        "Often lower than private insurance.",
        "Used here as a fallback.",
      ],
    },
    {
      title: "Medicare FFS (fee-for-service)",
      lines: [
        "Standard government pricing model.",
        "Think of it as a baseline reference price.",
      ],
    },
    {
      title: "Medicare Advantage",
      lines: [
        "Private plans that replace traditional Medicare.",
        "Prices vary and are less consistent in the dataset.",
      ],
    },
  ];

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Where the price comes from</CardTitle>
        <p className="text-sm leading-6 text-neutral-600">
          Not every hospital has the same type of price available, so different results may use
          different sources.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          {priceSources.map((source) => (
            <div key={source.title} className="border-l-2 border-teal-700 pl-4">
              <h3 className="font-semibold text-neutral-950">{source.title}</h3>
              <ul className="mt-2 space-y-1 text-sm leading-6 text-neutral-600">
                {source.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Method() {
  const methodNotes = [
    {
      text: "This demo compares hospitals using the data in this project.",
      tone: "affirming",
    },
    {
      text: "Estimated costs may come from different source types.",
      tone: "affirming",
    },
    {
      text: "Ratings describe the hospital overall, not the procedure.",
      tone: "affirming",
    },
    {
      text: "Missing hospital ratings remain missing and are not fabricated.",
      tone: "caution",
    },
    {
      text: "Distance scoring is not implemented yet, even though location fields are preserved.",
      tone: "caution",
    },
    {
      text: "This is not medical advice and should not be used as a real care decision tool.",
      tone: "caution",
    },
  ] as const;

  return (
    <section id="method" className="py-14">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Info className="h-5 w-5 text-teal-700" />
              <Badge variant="teal">Method</Badge>
            </div>
            <CardTitle>What this demo is and is not</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-5 md:grid-cols-2">
              {methodNotes.map((note) => (
                <div key={note.text} className="flex gap-3">
                  <span
                    className={
                      note.tone === "caution"
                        ? "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-700"
                        : "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-800"
                    }
                  >
                    {note.tone === "caution" ? (
                      <X className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <p className="text-sm leading-6 text-neutral-700">{note.text}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-white p-8 text-center">
      <Search className="mx-auto h-8 w-8 text-teal-700" />
      <h3 className="mt-4 text-lg font-semibold text-neutral-950">{title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-neutral-600">{text}</p>
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-44 animate-pulse rounded-lg border border-border bg-white p-5 shadow-soft">
          <div className="h-4 w-24 rounded-md bg-neutral-200" />
          <div className="mt-4 h-6 w-2/3 rounded-md bg-neutral-200" />
          <div className="mt-3 h-4 w-1/2 rounded-md bg-neutral-200" />
          <div className="mt-8 grid grid-cols-3 gap-3">
            <div className="h-12 rounded-md bg-neutral-200" />
            <div className="h-12 rounded-md bg-neutral-200" />
            <div className="h-12 rounded-md bg-neutral-200" />
          </div>
        </div>
      ))}
    </div>
  );
}
