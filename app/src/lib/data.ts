import Papa from "papaparse";

export type HospitalProcedure = {
  hospitalId: string;
  ccn: string;
  hospitalName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  fullAddress: string;
  procedureCode: string;
  procedureName: string;
  sourceYear: number | null;
  estimatedCost: number | null;
  estimatedCostSource: string;
  estimatedCostSourceLabel: string;
  qualityRating: number | null;
  highQuality: boolean | null;
  commercialToMedicare: number | null;
  chargeToMedicare: number | null;
  hospitalCommercialToMedicare: number | null;
  hospitalChargeToMedicare: number | null;
  hospitalType: string;
  hospitalOwnership: string;
  emergencyServices: string;
  dataSource: string;
};

export type ProcedureOption = {
  procedureCode: string;
  procedureName: string;
  hospitalCount: number;
  medianEstimatedCost: number | null;
};

export type CareFinderData = {
  rows: HospitalProcedure[];
  procedures: ProcedureOption[];
};

type CsvRecord = Record<string, string | undefined>;

const DATA_FILES = {
  hospitalProcedures: `${import.meta.env.BASE_URL}carefinder_hospital_procedures.csv`,
  procedures: `${import.meta.env.BASE_URL}carefinder_procedures.csv`,
};

function pick(row: CsvRecord, aliases: string[]) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function numeric(row: CsvRecord, aliases: string[]) {
  const value = pick(row, aliases);
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(row: CsvRecord, aliases: string[]) {
  const value = pick(row, aliases).toLowerCase();
  if (!value) {
    return null;
  }
  if (["true", "1", "yes", "y"].includes(value)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(value)) {
    return false;
  }
  return null;
}

function titleCase(value: string) {
  if (!value) {
    return "";
  }

  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
    .replace(/\bUs\b/g, "US")
    .replace(/\bAl\b/g, "AL")
    .replace(/\bAk\b/g, "AK")
    .replace(/\bAz\b/g, "AZ")
    .replace(/\bAr\b/g, "AR")
    .replace(/\bCa\b/g, "CA")
    .replace(/\bCo\b/g, "CO")
    .replace(/\bCt\b/g, "CT")
    .replace(/\bDc\b/g, "DC")
    .replace(/\bDe\b/g, "DE")
    .replace(/\bFl\b/g, "FL")
    .replace(/\bGa\b/g, "GA")
    .replace(/\bHi\b/g, "HI")
    .replace(/\bIa\b/g, "IA")
    .replace(/\bId\b/g, "ID")
    .replace(/\bIl\b/g, "IL")
    .replace(/\bIn\b/g, "IN")
    .replace(/\bKs\b/g, "KS")
    .replace(/\bKy\b/g, "KY")
    .replace(/\bLa\b/g, "LA")
    .replace(/\bMa\b/g, "MA")
    .replace(/\bMd\b/g, "MD")
    .replace(/\bMe\b/g, "ME")
    .replace(/\bMi\b/g, "MI")
    .replace(/\bMn\b/g, "MN")
    .replace(/\bMo\b/g, "MO")
    .replace(/\bMs\b/g, "MS")
    .replace(/\bMt\b/g, "MT")
    .replace(/\bNc\b/g, "NC")
    .replace(/\bNd\b/g, "ND")
    .replace(/\bNe\b/g, "NE")
    .replace(/\bNh\b/g, "NH")
    .replace(/\bNj\b/g, "NJ")
    .replace(/\bNm\b/g, "NM")
    .replace(/\bNv\b/g, "NV")
    .replace(/\bNy\b/g, "NY")
    .replace(/\bOh\b/g, "OH")
    .replace(/\bOk\b/g, "OK")
    .replace(/\bOr\b/g, "OR")
    .replace(/\bPa\b/g, "PA")
    .replace(/\bRi\b/g, "RI")
    .replace(/\bSc\b/g, "SC")
    .replace(/\bSd\b/g, "SD")
    .replace(/\bTn\b/g, "TN")
    .replace(/\bTx\b/g, "TX")
    .replace(/\bUt\b/g, "UT")
    .replace(/\bVa\b/g, "VA")
    .replace(/\bVt\b/g, "VT")
    .replace(/\bWa\b/g, "WA")
    .replace(/\bWi\b/g, "WI")
    .replace(/\bWv\b/g, "WV")
    .replace(/\bWy\b/g, "WY")
    .replace(/\bSt\b\.?/g, "St.")
    .replace(/\bMc([a-z])/g, (_match, letter: string) => `Mc${letter.toUpperCase()}`)
    .replace(/\bIi\b/g, "II")
    .replace(/\bIii\b/g, "III")
    .replace(/\bIv\b/g, "IV")
    .replace(/\bLlc\b/g, "LLC")
    .replace(/\bInc\b/g, "Inc.");
}

function formatProcedureName(value: string) {
  return titleCase(value)
    .replace(/\bMcc\b/g, "MCC")
    .replace(/\bCc\b/g, "CC")
    .replace(/\bDrg\b/g, "DRG")
    .replace(/\bMv\b/g, "MV");
}

async function loadCsv(path: string) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not load ${path}: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const parsed = Papa.parse<CsvRecord>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    const firstError = parsed.errors[0];
    throw new Error(`Could not parse ${path}: ${firstError.message}`);
  }

  return parsed.data;
}

function normalizeHospitalProcedure(row: CsvRecord): HospitalProcedure {
  const city = titleCase(pick(row, ["city", "Rndrng_Prvdr_City", "City/Town"]));
  const state = pick(row, ["state", "STATE", "Rndrng_Prvdr_State_Abrvtn"]).toUpperCase();
  const zip = pick(row, ["zip", "ZIP Code", "Rndrng_Prvdr_Zip5"]);
  const address = titleCase(pick(row, ["address", "Address", "Rndrng_Prvdr_St"]));
  const hospitalName = titleCase(
    pick(row, ["hospital_name", "Facility Name", "Rndrng_Prvdr_Org_Name", "PROVIDER_NAME"]),
  );

  return {
    hospitalId: pick(row, ["hospital_id", "CCN", "Rndrng_Prvdr_CCN"]),
    ccn: pick(row, ["CCN", "hospital_id", "Rndrng_Prvdr_CCN"]),
    hospitalName,
    address,
    city,
    state,
    zip,
    fullAddress: titleCase(pick(row, ["full_address"])) || [address, city, state, zip].filter(Boolean).join(", "),
    procedureCode: pick(row, ["procedure_code", "DRG_Cd", "DRG_CODE"]),
    procedureName: formatProcedureName(pick(row, ["procedure_name", "DRG_Desc", "DRG_DESC"])),
    sourceYear: numeric(row, ["source_year", "Year"]),
    estimatedCost: numeric(row, ["estimated_cost", "AVG_COMMERCIAL", "Avg_Tot_Pymt_Amt"]),
    estimatedCostSource: pick(row, ["estimated_cost_source"]),
    estimatedCostSourceLabel: pick(row, ["estimated_cost_source_label"]),
    qualityRating: numeric(row, ["quality_rating", "rating_num", "Hospital overall rating"]),
    highQuality: boolValue(row, ["high_quality"]),
    commercialToMedicare: numeric(row, ["commercial_to_medicare"]),
    chargeToMedicare: numeric(row, ["charge_to_medicare"]),
    hospitalCommercialToMedicare: numeric(row, ["hospital_commercial_to_medicare"]),
    hospitalChargeToMedicare: numeric(row, ["hospital_charge_to_medicare"]),
    hospitalType: pick(row, ["hospital_type", "Hospital Type"]),
    hospitalOwnership: pick(row, ["hospital_ownership", "Hospital Ownership"]),
    emergencyServices: pick(row, ["emergency_services", "Emergency Services"]),
    dataSource: pick(row, ["data_source"]),
  };
}

function normalizeProcedure(row: CsvRecord): ProcedureOption {
  return {
    procedureCode: pick(row, ["procedure_code", "DRG_Cd", "DRG_CODE"]),
    procedureName: formatProcedureName(pick(row, ["procedure_name", "DRG_Desc", "DRG_DESC"])),
    hospitalCount: numeric(row, ["hospital_count"]) ?? 0,
    medianEstimatedCost: numeric(row, ["median_estimated_cost"]),
  };
}

export async function loadCareFinderData(): Promise<CareFinderData> {
  const [hospitalProcedureRows, procedureRows] = await Promise.all([
    loadCsv(DATA_FILES.hospitalProcedures),
    loadCsv(DATA_FILES.procedures),
  ]);

  const rows = hospitalProcedureRows.map(normalizeHospitalProcedure).filter((row) => {
    return row.hospitalId && row.procedureCode && row.estimatedCost !== null;
  });

  const procedureMap = new Map<string, ProcedureOption>();
  for (const procedure of procedureRows.map(normalizeProcedure)) {
    if (procedure.procedureCode) {
      procedureMap.set(procedure.procedureCode, procedure);
    }
  }

  for (const row of rows) {
    if (!procedureMap.has(row.procedureCode)) {
      procedureMap.set(row.procedureCode, {
        procedureCode: row.procedureCode,
        procedureName: row.procedureName,
        hospitalCount: 0,
        medianEstimatedCost: null,
      });
    }
  }

  const procedures = Array.from(procedureMap.values()).sort((a, b) =>
    a.procedureCode.localeCompare(b.procedureCode),
  );

  return { rows, procedures };
}
