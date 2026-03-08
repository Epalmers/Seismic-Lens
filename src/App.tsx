import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import InfoTip from "./components/InfoTip";
import LocationMap from "./LocationMap";
import { computeElf, computeS1FromSD1, formatNum, formatV } from "./elf";

// ---------------------------------------------------------------------------
// Constants (per USGS ASCE7-22 docs)
// ---------------------------------------------------------------------------
const USGS_BASE = "https://earthquake.usgs.gov/ws/designmaps/asce7-22.json";
const FETCH_TIMEOUT_MS = 10000;

const VALID_RISK_CATEGORIES = ["I", "II", "III", "IV"] as const;
const SITE_CLASSES_FULL = ["Default", "A", "B", "BC", "C", "CD", "D", "DE", "E"] as const;
const SITE_CLASSES_SIMPLE = ["A", "B", "C", "D", "E"] as const;

const SENS_DEBOUNCE_MS = 500;

const PRESET_LOCATIONS = [
  { id: "fort-collins", label: "Fort Collins, CO", lat: 40.5853, lon: -105.0844 },
  { id: "denver", label: "Denver, CO", lat: 39.7392, lon: -104.9903 },
  { id: "los-angeles", label: "Los Angeles, CA", lat: 34.0522, lon: -118.2437 },
  { id: "new-york-city", label: "New York City, NY", lat: 40.7128, lon: -74.006 },
  { id: "seattle", label: "Seattle, WA", lat: 47.6062, lon: -122.3321 },
  { id: "memphis", label: "Memphis, TN", lat: 35.1495, lon: -90.049 },
  { id: "anchorage", label: "Anchorage, AK", lat: 61.2181, lon: -149.9003 },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type RiskCategory = (typeof VALID_RISK_CATEGORIES)[number];
type SiteClass = (typeof SITE_CLASSES_FULL)[number];

interface Asce7Data {
  sds: number;
  sd1: number;
  sdc: string;
  ts: number;
  t0: number;
  tl: number;
  spectrum: { periods: number[]; ordinates: number[] } | null;
  mcerSpectrum: { periods: number[]; ordinates: number[] } | null;
  verticalSpectrum?: { periods: number[]; ordinates: number[] } | null;
  verticalMcerSpectrum?: { periods: number[]; ordinates: number[] } | null;
  vs30?: number;
  modelVersion?: string;
  ss?: number;
  s1?: number;
  sms?: number;
  sm1?: number;
  pga?: number;
  pgam?: number;
}

interface SensitivityRow {
  siteClass: SiteClass;
  sds: number;
  sd1: number;
  sdc: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}
function isValidLon(lon: number): boolean {
  return Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

// Ie (Importance Factor) per ASCE 7-22 Table 1.5-2
function getIe(riskCategory: RiskCategory): number {
  switch (riskCategory) {
    case "I":
    case "II":
      return 1.0;
    case "III":
      return 1.25;
    case "IV":
      return 1.5;
    default:
      return 1.0;
  }
}

// ---------------------------------------------------------------------------
// USGS Fetch (robust: timeout + safe body parse)
// ---------------------------------------------------------------------------
async function fetchAsce7Data(
  latitude: number,
  longitude: number,
  riskCategory: RiskCategory,
  siteClass: SiteClass,
  title: string = "Request",
  signal?: AbortSignal
): Promise<Asce7Data> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    riskCategory,
    siteClass,
    title: title || "Request",
  });

  const url = `${USGS_BASE}?${params}`;

  const controller = new AbortController();
  let abortedByTimeout = false;
  const timeout = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());

  let res: Response;
  let text = "";
  try {
    res = await fetch(url, { signal: controller.signal });
    text = await res.text(); // read ONCE (avoids "body already used" issues)
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (abortedByTimeout) throw new Error("USGS request timed out — try again.");
      throw err; // Re-throw so callers can detect cancellation (new selection aborted previous batch)
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  // Try parse JSON from text; if it's not JSON, json stays null.
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }

  const req = json?.request as { status?: string; message?: string } | undefined;
  // Prefer USGS structured error if present
  if (req?.status === "error") {
    throw new Error(req.message || "USGS returned an error");
  }

  if (!res.ok) {
    const msg =
      (req?.message as string) ||
      ((json?.message as string) ?? (text ? text.slice(0, 140) : ""));
    throw new Error(`HTTP ${res.status}: ${res.statusText}${msg ? ` — ${msg}` : ""}`);
  }

  const response = json?.response as {
    data?: Record<string, unknown>;
    metadata?: { vs30?: number; modelVersion?: string };
  } | undefined;
  const data = response?.data;
  if (!data || typeof data !== "object") {
    throw new Error("Invalid USGS response: missing response.data");
  }
  const vs30 = response?.metadata?.vs30;
  const vs30Num = typeof vs30 === "number" && Number.isFinite(vs30) ? vs30 : undefined;
  const modelVersion = typeof response?.metadata?.modelVersion === "string" ? response.metadata.modelVersion : undefined;
  const optNum = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const toNum = (v: unknown, name: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Invalid USGS response: missing/invalid ${name}`);
    return n;
  };

  const parseSpec = (spec: { periods?: unknown; ordinates?: unknown } | undefined) => {
    if (!spec) return null;
    const periods = Array.isArray(spec.periods) ? (spec.periods as number[]).map(Number) : [];
    const ordinates = Array.isArray(spec.ordinates) ? (spec.ordinates as number[]).map(Number) : [];
    return periods.length && ordinates.length ? { periods, ordinates } : null;
  };

  const designSpec = data.multiPeriodDesignSpectrum as { periods?: unknown; ordinates?: unknown } | undefined;
  const mcerSpec = data.multiPeriodMCErSpectrum as { periods?: unknown; ordinates?: unknown } | undefined;
  const verticalDesign = data.verticalDesignSpectrum as { periods?: unknown; ordinates?: unknown } | undefined;
  const verticalMcer = data.verticalMCErSpectrum as { periods?: unknown; ordinates?: unknown } | undefined;

  return {
    sds: toNum(data.sds, "sds"),
    sd1: toNum(data.sd1, "sd1"),
    sdc: String(data.sdc ?? ""),
    ts: toNum(data.ts, "ts"),
    t0: toNum(data.t0, "t0"),
    tl: toNum(data.tl, "tl"),
    spectrum: parseSpec(designSpec),
    mcerSpectrum: parseSpec(mcerSpec),
    verticalSpectrum: parseSpec(verticalDesign),
    verticalMcerSpectrum: parseSpec(verticalMcer),
    vs30: vs30Num,
    modelVersion,
    ss: optNum(data.ss),
    s1: optNum(data.s1),
    sms: optNum(data.sms),
    sm1: optNum(data.sm1),
    pga: optNum(data.pga),
    pgam: optNum(data.pgam),
  };
}

// ---------------------------------------------------------------------------
// Share URL (query params)
// ---------------------------------------------------------------------------
function buildShareUrl(params: {
  presetId: string;
  manualLat: string;
  manualLon: string;
  riskCategory: RiskCategory;
  siteClass: SiteClass;
  compareSimplified: boolean;
  sensitivityMetric: "SDS" | "SD1";
  spectrumType: "design" | "mcer";
}): string {
  const sp = new URLSearchParams();
  if (params.presetId) sp.set("p", params.presetId);
  else {
    if (params.manualLat) sp.set("lat", params.manualLat);
    if (params.manualLon) sp.set("lon", params.manualLon);
  }
  sp.set("rc", params.riskCategory);
  sp.set("sc", params.siteClass);
  sp.set("sim", params.compareSimplified ? "1" : "0");
  sp.set("met", params.sensitivityMetric);
  sp.set("spec", params.spectrumType);
  return `${typeof window !== "undefined" ? window.location.origin + window.location.pathname : ""}?${sp.toString()}`;
}

function parseShareUrl(): Partial<{
  presetId: string;
  manualLat: string;
  manualLon: string;
  riskCategory: RiskCategory;
  siteClass: SiteClass;
  compareSimplified: boolean;
  sensitivityMetric: "SDS" | "SD1";
  spectrumType: "design" | "mcer";
}> {
  if (typeof window === "undefined") return {};
  const sp = new URLSearchParams(window.location.search);
  const out: ReturnType<typeof parseShareUrl> = {};
  const p = sp.get("p");
  if (p && PRESET_LOCATIONS.some((x) => x.id === p)) out.presetId = p;
  else {
    const lat = sp.get("lat");
    const lon = sp.get("lon");
    if (lat) out.manualLat = lat;
    if (lon) out.manualLon = lon;
  }
  const rc = sp.get("rc");
  if (rc && VALID_RISK_CATEGORIES.includes(rc as RiskCategory)) out.riskCategory = rc as RiskCategory;
  const sc = sp.get("sc");
  if (sc && SITE_CLASSES_FULL.includes(sc as SiteClass)) out.siteClass = sc as SiteClass;
  const sim = sp.get("sim");
  if (sim === "0") out.compareSimplified = false;
  else if (sim === "1") out.compareSimplified = true;
  const met = sp.get("met");
  if (met === "SDS" || met === "SD1") out.sensitivityMetric = met;
  const spec = sp.get("spec");
  if (spec === "design" || spec === "mcer") out.spectrumType = spec;
  return out;
}

// ---------------------------------------------------------------------------
// Build USGS URL (for Copy button)
// ---------------------------------------------------------------------------
function buildUsgsUrl(
  lat: number,
  lon: number,
  riskCategory: RiskCategory,
  siteClass: SiteClass,
  title: string
): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    riskCategory,
    siteClass,
    title: title || "Request",
  });
  return `${USGS_BASE}?${params}`;
}

// ---------------------------------------------------------------------------
// Insights (structured bullets)
// ---------------------------------------------------------------------------
interface InsightItem {
  label: string;
  value?: string;
}

function generateInsights(
  _locationLabel: string,
  riskCategory: RiskCategory,
  siteClass: SiteClass,
  data: Asce7Data | null,
  sensitivityData: SensitivityRow[] | null,
  sensitivityMetric: "SDS" | "SD1"
): { whatItMeans: InsightItem[]; keyFindings: InsightItem[]; nextSteps: string[] } {
  const defaultEmpty = {
    whatItMeans: [{ label: "Select a location and site class to load seismic design data." }],
    keyFindings: [],
    nextSteps: ["Choose a location from the Parameters card to begin."],
  };
  if (!data) return defaultEmpty;

  const sdsText = data.sds.toFixed(3);
  const sd1Text = data.sd1.toFixed(3);
  const sdc = data.sdc;
  const ie = getIe(riskCategory);
  const tsText = data.ts.toFixed(3);
  const t0Text = data.t0.toFixed(3);
  const tlText = data.tl.toFixed(3);

  const whatItMeans: InsightItem[] = [
    { label: "Short-period design spectral acceleration", value: `${sdsText}g` },
    { label: "1-sec design spectral acceleration", value: `${sd1Text}g` },
    { label: "Seismic Design Category", value: sdc },
    { label: "Importance factor (Risk Cat. affects Ie & SDC thresholds)", value: String(ie) },
  ];

  const keyFindings: InsightItem[] = [
    { label: "Primary design values", value: `SDS = ${sdsText}g, SD1 = ${sd1Text}g` },
    { label: "Spectral corners", value: `T0 = ${t0Text}s, Ts = ${tsText}s, TL = ${tlText}s` },
  ];

  if (sensitivityData && sensitivityData.length > 0) {
    const metricKey = sensitivityMetric === "SDS" ? "sds" : "sd1";
    const refCandidates: SiteClass[] = ["D", "Default", "C"];
    const refRow =
      refCandidates.map((c) => sensitivityData.find((r) => r.siteClass === c)).find(Boolean) ??
      sensitivityData[0];
    const refValue = refRow[metricKey];
    if (Number.isFinite(refValue) && refValue > 0) {
      const maxRow = sensitivityData.reduce((a, b) => (b[metricKey] > a[metricKey] ? b : a));
      const pct = ((maxRow[metricKey] - refValue) / refValue) * 100;
      keyFindings.push({
        label: `Highest ${sensitivityMetric} site class`,
        value: `${maxRow.siteClass} (${maxRow[metricKey].toFixed(3)}g, +${Math.abs(pct).toFixed(1)}% vs ${refRow.siteClass})`,
      });
    }
  }

  const nextSteps: string[] = [
    "Use SDS and SD1 with your R factor and Ie for base shear calculation.",
    "Risk Category mainly affects Ie and SDC; SDS/SD1 depend on location and site class.",
  ];
  if (sdc && ["D", "E", "F"].some((c) => sdc.startsWith(c))) {
    nextSteps.push("Higher SDC may require additional detailing per ASCE 7-22.");
  }
  const s1Val = data.s1;
  if (siteClass === "D" || siteClass === "CD" || siteClass === "DE") {
    if (s1Val != null && Number.isFinite(s1Val) && s1Val >= 0.2) {
      nextSteps.push("Site Class D with S1 ≥ 0.2g may require site-specific ground motion analysis per ASCE 7-22 §11.4.8.");
    }
  }
  if (siteClass === "E") {
    nextSteps.push("Site Class E may require site-specific analysis. Consult ASCE 7-22 §11.4.8.");
  }

  return { whatItMeans, keyFindings, nextSteps };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const INITIAL_FROM_URL = (() => {
  const parsed = parseShareUrl();
  const hasManual = parsed.manualLat != null && parsed.manualLon != null;
  return {
    presetId: hasManual ? "" : (parsed.presetId ?? PRESET_LOCATIONS[0].id),
    manualLat: parsed.manualLat ?? "",
    manualLon: parsed.manualLon ?? "",
    riskCategory: (parsed.riskCategory ?? "II") as RiskCategory,
    siteClass: (parsed.siteClass ?? "Default") as SiteClass,
    compareSimplified: parsed.compareSimplified ?? true,
    sensitivityMetric: (parsed.sensitivityMetric ?? "SDS") as "SDS" | "SD1",
    spectrumType: (parsed.spectrumType ?? "design") as "design" | "mcer",
  };
})();

export default function App() {
  const [presetId, setPresetId] = useState<string>(INITIAL_FROM_URL.presetId);
  const [manualLat, setManualLat] = useState(INITIAL_FROM_URL.manualLat);
  const [manualLon, setManualLon] = useState(INITIAL_FROM_URL.manualLon);
  const [riskCategory, setRiskCategory] = useState<RiskCategory>(INITIAL_FROM_URL.riskCategory);
  const [siteClass, setSiteClass] = useState<SiteClass>(INITIAL_FROM_URL.siteClass);
  const [compareSimplified, setCompareSimplified] = useState(INITIAL_FROM_URL.compareSimplified);
  const [sensitivityMetric, setSensitivityMetric] = useState<"SDS" | "SD1">(INITIAL_FROM_URL.sensitivityMetric);
  const [spectrumType, setSpectrumType] = useState<"design" | "mcer">(INITIAL_FROM_URL.spectrumType);
  const [spectrumXScale, setSpectrumXScale] = useState<"linear" | "log">("linear");

  const [elfR, setElfR] = useState(8);
  const [elfW, setElfW] = useState<number | "">("");
  const [elfT, setElfT] = useState<number | "">("");
  const [elfS1Override, setElfS1Override] = useState<number | "">("");
  const [elfIeOverride, setElfIeOverride] = useState(false);
  const [elfIeOverrideVal, setElfIeOverrideVal] = useState(1);

  const [data, setData] = useState<Asce7Data | null>(null);
  const [prevData, setPrevData] = useState<{ data: Asce7Data; ie: number } | null>(null);
  const lastFetchRiskCategoryRef = useRef<RiskCategory | null>(null);
  const [sensitivityData, setSensitivityData] = useState<SensitivityRow[] | null>(null);
  const [rcCompareData, setRcCompareData] = useState<{ ii: Asce7Data; iv: Asce7Data } | null>(null);

  const [loading, setLoading] = useState(false);
  const [sensitivityLoading, setSensitivityLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [sensitivityError, setSensitivityError] = useState<string | null>(null);
  const [sensitivityFailedClasses, setSensitivityFailedClasses] = useState<SiteClass[]>([]);
  const [requestDetailsOpen, setRequestDetailsOpen] = useState(false);
  const [mapCollapsed, setMapCollapsed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [verticalSpectrumOpen, setVerticalSpectrumOpen] = useState(false);

  const [lastApiUrl, setLastApiUrl] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [coordsCopied, setCoordsCopied] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const [showUpdatedBadge, setShowUpdatedBadge] = useState(false);

  // Sync state to URL (shareable permalink)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = buildShareUrl({
      presetId,
      manualLat,
      manualLon,
      riskCategory,
      siteClass,
      compareSimplified,
      sensitivityMetric,
      spectrumType,
    });
    const newSearch = new URL(url).search;
    if (window.location.search !== newSearch) {
      window.history.replaceState(null, "", window.location.pathname + newSearch);
    }
  }, [presetId, manualLat, manualLon, riskCategory, siteClass, compareSimplified, sensitivityMetric, spectrumType]);

  const preset = presetId ? PRESET_LOCATIONS.find((p) => p.id === presetId) : null;
  const lat = preset ? preset.lat : parseFloat(manualLat);
  const lon = preset ? preset.lon : parseFloat(manualLon);

  const locationLabel = preset
    ? preset.label
    : manualLat && manualLon && isValidLat(parseFloat(manualLat)) && isValidLon(parseFloat(manualLon))
      ? `(${manualLat}, ${manualLon})`
      : "Custom";

  const useManual = !preset;

  // Simplified: only A,B,C,D,E. Include Default when user's site class is Default.
  const { siteClassesForCompare, siteClassesKey } = useMemo(() => {
    const list: SiteClass[] = compareSimplified
      ? ([...SITE_CLASSES_SIMPLE] as unknown as SiteClass[])
      : ([...SITE_CLASSES_FULL] as unknown as SiteClass[]);
    if (compareSimplified && siteClass === "Default" && !list.includes("Default")) {
      list.unshift("Default");
    }
    return { siteClassesForCompare: list, siteClassesKey: list.join("|") };
  }, [compareSimplified, siteClass]);

  // -----------------------------
  // Main data: ALWAYS auto-fetch
  // -----------------------------
  const mainRunIdRef = useRef(0);

  useEffect(() => {
    if (!isValidLat(lat) || !isValidLon(lon)) {
      setError("Invalid coordinates");
      setLoading(false);
      return;
    }

    const ac = new AbortController();
    const runId = ++mainRunIdRef.current;

    setLoading(true);
    setError(null);
    const title = `${locationLabel}-${riskCategory}-${siteClass}`;
    const url = buildUsgsUrl(lat, lon, riskCategory, siteClass, title);

    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
      console.log("[Seismic Lens] Request fired:", { location: locationLabel, lat, lon, riskCategory, siteClass, spectrumType });
    }

    fetchAsce7Data(lat, lon, riskCategory, siteClass, title, ac.signal)
      .then((result) => {
        if (mainRunIdRef.current !== runId) return;
        setPrevData(
          data && lastFetchRiskCategoryRef.current !== null
            ? { data, ie: getIe(lastFetchRiskCategoryRef.current) }
            : null
        );
        lastFetchRiskCategoryRef.current = riskCategory;
        setData(result);
        setLastApiUrl(url);
        setLastUpdatedAt(new Date());
        setShowUpdatedBadge(true);
        setTimeout(() => setShowUpdatedBadge(false), 2500);
      })
      .catch((e) => {
        if (mainRunIdRef.current !== runId) return;
        const msg = e instanceof Error ? e.message : "Failed to fetch data";
        setError(/timed out/i.test(msg) ? "USGS request timed out — try again." : msg);
      })
      .finally(() => {
        if (mainRunIdRef.current !== runId) return;
        setLoading(false);
      });

    return () => ac.abort();
  }, [lat, lon, riskCategory, siteClass, locationLabel]);

  // -----------------------------
  // Sensitivity: auto-fetch (Promise.allSettled + cache)
  // -----------------------------
  const sensitivityRunIdRef = useRef(0);
  const sensitivityCacheRef = useRef<Map<string, { rows: SensitivityRow[]; failed: SiteClass[] }>>(new Map());

  useEffect(() => {
    if (!isValidLat(lat) || !isValidLon(lon)) return;

    const cacheKey = `${lat},${lon},${riskCategory},${siteClassesKey}`;
    const cached = sensitivityCacheRef.current.get(cacheKey);
    if (cached) {
      setSensitivityData(cached.rows);
      setSensitivityFailedClasses(cached.failed);
      setSensitivityError(cached.failed.length > 0 ? `Loaded ${cached.rows.length}/${siteClassesForCompare.length}. Failed: ${cached.failed.join(", ")}` : null);
      setSensitivityLoading(false);
      return;
    }

    const ac = new AbortController();

    const timer = setTimeout(() => {
      const runId = ++sensitivityRunIdRef.current;
      const classes = siteClassesForCompare;

      setSensitivityLoading(true);
      setSensitivityError(null);

      (async () => {
        const results = await Promise.allSettled(
          classes.map((sc) =>
            fetchAsce7Data(lat, lon, riskCategory, sc, `${locationLabel}-${sc}`, ac.signal)
          )
        );

        if (sensitivityRunIdRef.current !== runId) return;

        const rows: SensitivityRow[] = [];
        const failed: { sc: SiteClass; err: string }[] = [];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const sc = classes[i];
          if (r.status === "fulfilled") {
            const d = r.value;
            if (Number.isFinite(d.sds) && Number.isFinite(d.sd1)) {
              rows.push({ siteClass: sc, sds: d.sds, sd1: d.sd1, sdc: d.sdc });
            }
          } else {
            failed.push({ sc, err: r.reason instanceof Error ? r.reason.message : String(r.reason) });
          }
        }

        const order = new Map(classes.map((c, i) => [c, i]));
        rows.sort((a, b) => (order.get(a.siteClass) ?? 0) - (order.get(b.siteClass) ?? 0));

        const failedClasses = failed.map((f) => f.sc);
        sensitivityCacheRef.current.set(cacheKey, { rows, failed: failedClasses });

        if (rows.length === 0) {
          setSensitivityError(failed[0]?.err || "Failed to fetch sensitivity data");
          setSensitivityData(null);
          setSensitivityFailedClasses(failedClasses);
        } else {
          setSensitivityData(rows);
          setSensitivityFailedClasses(failedClasses);
          if (failed.length > 0) {
            setSensitivityError(
              `Loaded ${rows.length}/${classes.length}. Failed: ${failedClasses.join(", ")}`
            );
          } else {
            setSensitivityError(null);
            setSensitivityFailedClasses([]);
          }
        }

        setSensitivityLoading(false);
      })();
    }, SENS_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [lat, lon, riskCategory, compareSimplified, siteClassesKey, locationLabel, retryKey]);

  // -----------------------------
  // Risk Category Compare (RC II vs RC IV) — cached
  // -----------------------------
  const rcCompareCacheRef = useRef<Map<string, { ii: Asce7Data; iv: Asce7Data }>>(new Map());
  useEffect(() => {
    if (!isValidLat(lat) || !isValidLon(lon)) {
      setRcCompareData(null);
      return;
    }
    const cacheKey = `${lat},${lon},${siteClass}`;
    const cached = rcCompareCacheRef.current.get(cacheKey);
    if (cached) {
      setRcCompareData(cached);
      return;
    }
    const ac = new AbortController();
    Promise.all([
      fetchAsce7Data(lat, lon, "II", siteClass, `RCII-${locationLabel}`, ac.signal),
      fetchAsce7Data(lat, lon, "IV", siteClass, `RCIV-${locationLabel}`, ac.signal),
    ])
      .then(([ii, iv]) => {
        rcCompareCacheRef.current.set(cacheKey, { ii, iv });
        setRcCompareData({ ii, iv });
      })
      .catch(() => setRcCompareData(null));
    return () => ac.abort();
  }, [lat, lon, siteClass, locationLabel]);

  // Chart data: for log scale, filter period==0 and ensure min 0.01; for linear, filter period==0 only
  const spectrumChartData = useMemo(() => {
    const spec = spectrumType === "design" ? data?.spectrum : data?.mcerSpectrum;
    if (!spec?.periods?.length || !spec.ordinates?.length) return [];
    const len = Math.min(spec.periods.length, spec.ordinates.length);
    const minPeriod = spectrumXScale === "log" ? 0.01 : 0;
    const out: { period: number; Sa: number }[] = [];
    for (let i = 0; i < len; i++) {
      const p = spec.periods[i];
      const sa = spec.ordinates[i];
      if (Number.isFinite(p) && p > minPeriod && Number.isFinite(sa)) out.push({ period: p, Sa: sa });
    }
    return out;
  }, [data, spectrumType, spectrumXScale]);

  const verticalSpectrumChartData = useMemo(() => {
    const spec = spectrumType === "design" ? data?.verticalSpectrum : data?.verticalMcerSpectrum;
    if (!spec?.periods?.length || !spec.ordinates?.length) return [];
    const len = Math.min(spec.periods.length, spec.ordinates.length);
    const minPeriod = spectrumXScale === "log" ? 0.01 : 0;
    const out: { period: number; Sa: number }[] = [];
    for (let i = 0; i < len; i++) {
      const p = spec.periods[i];
      const sa = spec.ordinates[i];
      if (Number.isFinite(p) && p > minPeriod && Number.isFinite(sa)) out.push({ period: p, Sa: sa });
    }
    return out;
  }, [data, spectrumType, spectrumXScale]);

  const hasVerticalSpectrum = verticalSpectrumChartData.length > 0;

  const sensitivityRefClass: SiteClass = sensitivityData?.some((r) => r.siteClass === "D")
    ? "D"
    : sensitivityData?.[0]?.siteClass ?? "D";
  const sensitivityRefValue =
    sensitivityData?.find((r) => r.siteClass === sensitivityRefClass)?.[
      sensitivityMetric === "SDS" ? "sds" : "sd1"
    ] ?? 0;

  const sensitivityChartData = useMemo(() => {
    const raw =
      sensitivityData?.map((r) => {
        const v = sensitivityMetric === "SDS" ? r.sds : r.sd1;
        const pct =
          Number.isFinite(sensitivityRefValue) && sensitivityRefValue > 0
            ? ((v - sensitivityRefValue) / sensitivityRefValue) * 100
            : null;
        return { siteClass: r.siteClass, value: v, pct };
      }) ?? [];
    if (raw.length === 0) return raw;
    const order = new Map(siteClassesForCompare.map((c, i) => [c, i]));
    return [...raw].sort((a, b) => (order.get(a.siteClass) ?? 99) - (order.get(b.siteClass) ?? 99));
  }, [sensitivityData, sensitivityMetric, sensitivityRefValue, siteClassesForCompare]);

  const elfIe = elfIeOverride ? elfIeOverrideVal : getIe(riskCategory);
  const computedS1 = useMemo(
    () => (data && (data.s1 == null || !Number.isFinite(data.s1)) ? computeS1FromSD1(data.sd1, siteClass) : null),
    [data, siteClass]
  );
  const effectiveS1 = data?.s1 != null && Number.isFinite(data.s1) ? data.s1 : computedS1;
  useEffect(() => {
    if (!exportOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExportOpen(false);
        exportButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    exportMenuRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [exportOpen]);

  const elfResult = useMemo(() => {
    if (!data) return null;
    const w = typeof elfW === "number" ? elfW : parseFloat(String(elfW));
    const t = typeof elfT === "number" ? elfT : parseFloat(String(elfT));
    const s1 = typeof elfS1Override === "number" ? elfS1Override : (elfS1Override === "" ? null : parseFloat(String(elfS1Override)));
    const s1Val = s1 != null && Number.isFinite(s1) ? s1 : (data.s1 != null && Number.isFinite(data.s1) ? data.s1 : computedS1);
    return computeElf({
      sds: data.sds,
      sd1: data.sd1,
      ts: data.ts,
      sdc: data.sdc,
      ie: elfIe,
      r: elfR,
      w,
      t,
      s1Override: s1Val,
    });
  }, [data, elfR, elfW, elfT, elfS1Override, elfIe, computedS1]);

  const insights = generateInsights(
    locationLabel,
    riskCategory,
    siteClass,
    data,
    sensitivityData,
    sensitivityMetric
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="no-print border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-slate-800 text-sm font-semibold text-white">
            SL
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Seismic Lens</h1>
            <p className="text-xs text-slate-500">ASCE 7-22 Site Report &amp; Site Class Sensitivity</p>
          </div>
        </div>
      </header>

      {/* Hero + Disclaimer */}
      <section className="border-b border-slate-200 bg-white px-4 py-3 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <h2 className="text-base font-semibold text-slate-900">ASCE 7-22 Seismic Screening</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            Design response spectrum (SDS, SD1), site class sensitivity, and base shear from USGS.
          </p>
          <p className="mt-1.5 text-xs text-slate-400">
            Screening only — not for final design. Verify with site-specific studies and ASCE 7-22.{" "}
            <a
              href="https://earthquake.usgs.gov/ws/designmaps/asce7-22.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-500 underline hover:text-slate-700"
            >
              Learn more
            </a>
          </p>
        </div>
      </section>

      {/* Parameters Card */}
      <section className="px-4 py-3 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-base font-medium text-slate-900">Parameters</h2>
              <p className="text-xs text-slate-500">Location, Risk Category, and Site Class Inputs</p>
            </div>
            <div className="grid gap-4 p-4 lg:grid-cols-[1fr_minmax(280px,340px)] lg:items-stretch">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">Location</label>
                  <select
                    value={presetId}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPresetId(v);
                      setManualLat("");
                      setManualLon("");
                    }}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  >
                    {PRESET_LOCATIONS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                    <option value="">Custom (enter below)</option>
                  </select>
                </div>
                {useManual && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Latitude</label>
                      <input
                        type="text"
                        value={manualLat}
                        onChange={(e) => setManualLat(e.target.value)}
                        placeholder="e.g. 40.59"
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700">Longitude</label>
                      <input
                        type="text"
                        value={manualLon}
                        onChange={(e) => setManualLon(e.target.value)}
                        placeholder="e.g. -105.08"
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                      />
                    </div>
                  </div>
                )}
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Site Class</label>
                  <select
                    value={siteClass}
                    onChange={(e) => setSiteClass(e.target.value as SiteClass)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  >
                    {SITE_CLASSES_FULL.map((sc) => (
                      <option key={sc} value={sc}>{sc}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-5">
                <div>
                    <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                    Risk Category
                    <InfoTip
                      text="USGS hazard values (SDS/SD1) usually don't change with Risk Category. Risk Category affects Ie and SDC thresholds."
                      placement="top"
                    />
                  </label>
                  <div className="inline-flex rounded-md bg-slate-100 p-1">
                    {VALID_RISK_CATEGORIES.map((rc) => (
                      <button
                        type="button"
                        key={rc}
                        onClick={() => setRiskCategory(rc)}
                        title={`Ie = ${getIe(rc)}`}
                        className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                          riskCategory === rc ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        {rc}
                      </button>
                    ))}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">Affects Ie and SDC thresholds</p>
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                    Sensitivity Chart
                    <InfoTip
                      text="Compare SDS/SD1 across site classes to understand geotech impact. Use sensitivity to inform site-specific studies."
                      placement="top"
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <div className="inline-flex rounded-md bg-slate-100 p-1">
                      <button
                        type="button"
                        onClick={() => setCompareSimplified(true)}
                        className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                          compareSimplified ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        Simplified
                      </button>
                      <button
                        type="button"
                        onClick={() => setCompareSimplified(false)}
                        className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                          !compareSimplified ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        Detailed
                      </button>
                    </div>
                    <div className="inline-flex rounded-md bg-slate-100 p-1">
                      <button
                        type="button"
                        onClick={() => setSensitivityMetric("SDS")}
                        className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                          sensitivityMetric === "SDS" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        SDS
                      </button>
                      <button
                        type="button"
                        onClick={() => setSensitivityMetric("SD1")}
                        className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                          sensitivityMetric === "SD1" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        SD1
                      </button>
                    </div>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Simplified: A, B, C, D, E · Detailed: Default + full list
                  </p>
                </div>
              </div>
            </div>
            {/* Location Map (right column, collapsible on mobile) */}
            <div className="flex min-h-0 flex-col border-t border-slate-200 pt-4 lg:border-t-0 lg:border-l lg:pl-4 lg:pt-0">
              <button
                type="button"
                className="no-print mb-2 flex items-center gap-2 text-left text-sm font-medium text-slate-700 lg:cursor-default"
                onClick={() => setMapCollapsed((c) => !c)}
                aria-expanded={!mapCollapsed}
              >
                Location Map
                <span className="lg:hidden">{mapCollapsed ? "▸" : "▾"}</span>
              </button>
              <div className={`flex min-h-0 flex-1 flex-col ${mapCollapsed ? "max-lg:hidden" : ""}`}>
                <div className="min-h-[200px] flex-1">
                  <LocationMap
                    lat={lat}
                    lon={lon}
                    locationLabel={locationLabel}
                    valid={isValidLat(lat) && isValidLon(lon)}
                  />
                </div>
                {isValidLat(lat) && isValidLon(lon) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-600">
                      {lat.toFixed(6)}, {lon.toFixed(6)}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
                          setCoordsCopied(true);
                          setTimeout(() => setCoordsCopied(false), 2000);
                        } catch {}
                      }}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      {coordsCopied ? "Copied" : "Copy"}
                    </button>
                    <a
                      href={`https://www.google.com/maps?q=${lat},${lon}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
                    >
                      Open in Google Maps
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
          </div>
        </div>
      </section>

      {/* Error banners */}
      {(error || sensitivityError) && (
        <div className="mx-auto max-w-7xl px-4 py-2 sm:px-6 lg:px-8">
          {error && (
            <div className="mb-2 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              <span className="text-amber-500" aria-hidden>⚠</span>
              <div className="flex-1">
                <p>{error} Previous data retained.</p>
                {lastUpdatedAt && data && (
                  <p className="mt-1 text-xs text-amber-700">
                    Data from {lastUpdatedAt.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}. Retry to refresh.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setError(null); setRetryKey((k) => k + 1); }}
                className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50"
              >
                Retry
              </button>
            </div>
          )}
          {sensitivityError && (
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              <span className="text-amber-500" aria-hidden>⚠</span>
              <span className="flex-1">{sensitivityError} Previous sensitivity data retained.</span>
              <button
                type="button"
                onClick={() => {
                  setSensitivityError(null);
                  const key = `${lat},${lon},${riskCategory},${siteClassesKey}`;
                  sensitivityCacheRef.current.delete(key);
                  setRetryKey((k) => k + 1);
                }}
                className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main grid */}
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-3 sm:px-6 lg:px-8">
        {/* KPI cards */}
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-medium text-slate-900">Key Values</h2>
              {showUpdatedBadge && (
                <span
                  className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                  role="status"
                  aria-live="polite"
                >
                  Updated
                </span>
              )}
              <span className="text-xs text-slate-500">
                {lastUpdatedAt
                  ? `Last updated ${lastUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Values from USGS ASCE 7-22 API"}
              </span>
            </div>
            <div className="no-print flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(buildShareUrl({ presetId, manualLat, manualLon, riskCategory, siteClass, compareSimplified, sensitivityMetric, spectrumType }));
                    setShareLinkCopied(true);
                    setTimeout(() => setShareLinkCopied(false), 2000);
                  } catch {}
                }}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {shareLinkCopied ? "Copied" : "Share Link"}
              </button>
              {lastApiUrl && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(lastApiUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {}
                  }}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {copied ? "Copied" : "Copy API URL"}
                </button>
              )}
              <div className="relative">
                <button
                  ref={exportButtonRef}
                  type="button"
                  onClick={() => setExportOpen((o) => !o)}
                  aria-expanded={exportOpen}
                  aria-haspopup="menu"
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Export ▾
                </button>
                {exportOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      aria-hidden
                      onClick={() => {
                        setExportOpen(false);
                        exportButtonRef.current?.focus();
                      }}
                    />
                    <div
                      ref={exportMenuRef}
                      role="menu"
                      tabIndex={-1}
                      className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-md border border-slate-200 bg-white py-1 shadow-lg focus:outline-none"
                    >
                      {data && (
                        <button
                          type="button"
                          className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                          onClick={() => {
                            const blob = new Blob(
                              [JSON.stringify({ data, locationLabel, riskCategory, siteClass, lastUpdatedAt: lastUpdatedAt?.toISOString() }, null, 2)],
                              { type: "application/json" }
                            );
                            const a = document.createElement("a");
                            a.href = URL.createObjectURL(blob);
                            a.download = `seismic-lens-${locationLabel.replace(/[^a-z0-9]/gi, "-")}-${Date.now()}.json`;
                            a.click();
                            URL.revokeObjectURL(a.href);
                            setExportOpen(false);
                            exportButtonRef.current?.focus();
                          }}
                        >
                          Download JSON
                        </button>
                      )}
                      {sensitivityData && sensitivityData.length > 0 && (
                        <button
                          type="button"
                          className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                          onClick={() => {
                            const header = "siteClass,sds,sd1,sdc\n";
                            const rows = sensitivityData.map((r) => `${r.siteClass},${r.sds.toFixed(4)},${r.sd1.toFixed(4)},${r.sdc}`).join("\n");
                            const blob = new Blob([header + rows], { type: "text/csv" });
                            const a = document.createElement("a");
                            a.href = URL.createObjectURL(blob);
                            a.download = `sensitivity-${locationLabel.replace(/[^a-z0-9]/gi, "-")}-${Date.now()}.csv`;
                            a.click();
                            URL.revokeObjectURL(a.href);
                            setExportOpen(false);
                            exportButtonRef.current?.focus();
                          }}
                        >
                          Download CSV
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          setExportOpen(false);
                          exportButtonRef.current?.focus();
                          setTimeout(() => window.print(), 100);
                        }}
                      >
                        Print Report (Save as PDF)
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
          {(["SDS", "SD1", "SDC", "Ie", "Ts", "T0", "TL"] as const).map((key) => {
            const labels: Record<string, string> = {
              SDS: "SDS",
              SD1: "SD1",
              SDC: "SDC",
              Ie: "Ie",
              Ts: "Ts",
              T0: "T0",
              TL: "TL",
            };
            const longDesc: Record<string, string> = {
              SDS: "Short-period design spectral acceleration",
              SD1: "1-sec design spectral acceleration",
              SDC: "Seismic Design Category",
              Ie: "Importance factor",
              Ts: "Transition period",
              T0: "Corner period",
              TL: "Long-period transition",
            };
            const tooltips: Record<string, string> = {
              SDS: "Short-period design spectral acceleration (g). Governs short/stiff structures. ASCE 7-22 §11.4.4.",
              SD1: "1-sec design spectral acceleration (g). Governs taller/more flexible structures. ASCE 7-22 §11.4.4.",
              SDC: "Seismic Design Category (A–F). Drives detailing, system limits, and design requirements.",
              Ie: "Importance factor (dimensionless). From Risk Category (I–IV). Higher Ie → higher design forces.",
              Ts: "Transition period Ts = SD1/SDS (s). Separates short-period from long-period spectrum region.",
              T0: "Corner period T0 = 0.2·Ts (s). Start of constant-acceleration plateau.",
              TL: "Long-period transition TL (s). Site-specific; affects very long-period response.",
            };
            const dataKeys: Record<string, keyof Asce7Data | null> = {
              SDS: "sds",
              SD1: "sd1",
              SDC: "sdc",
              Ie: null,
              Ts: "ts",
              T0: "t0",
              TL: "tl",
            };
            const val =
              key === "Ie" ? getIe(riskCategory) : data && dataKeys[key] ? data[dataKeys[key] as keyof Asce7Data] : null;
            const display =
              val != null ? (typeof val === "number" ? val.toFixed(val % 1 === 0 ? 0 : 3) : String(val)) : "—";
            const units: Record<string, string> = {
              SDS: "g",
              SD1: "g",
              SDC: "",
              Ie: "",
              Ts: "s",
              T0: "s",
              TL: "s",
            };
            const unitStr = units[key];
            const displayWithUnit = display !== "—" && unitStr ? `${display} ${unitStr}` : display;

            const isNumeric = ["SDS", "SD1", "Ts", "T0", "TL"].includes(key);
            const currentNum = isNumeric && val != null && typeof val === "number" ? val : null;
            const prevNum = prevData && isNumeric ? (prevData.data[dataKeys[key] as keyof Asce7Data] as number) : null;
            const delta = currentNum != null && prevNum != null && Number.isFinite(prevNum)
              ? currentNum - prevNum
              : null;
            const gThreshold = 0.005;
            const sThreshold = 0.01;
            const showDelta =
              delta != null &&
              (key === "SDS" || key === "SD1" ? Math.abs(delta) >= gThreshold : Math.abs(delta) >= sThreshold);
            const deltaStr =
              showDelta && delta != null
                ? `Δ ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(3)}${key === "SDS" || key === "SD1" ? "g" : "s"}`
                : null;

            const isNonNumeric = ["SDC", "Ie"].includes(key);
            const currentNonNum = isNonNumeric ? (key === "Ie" ? getIe(riskCategory) : data?.sdc ?? "") : null;
            const prevNonNum = prevData
              ? (key === "Ie" ? prevData.ie : prevData.data.sdc ?? "")
              : null;
            const showChanged =
              isNonNumeric && prevData != null && currentNonNum !== prevNonNum;

            return (
              <div
                key={key}
                className="rounded-md border border-slate-200 bg-white p-3"
              >
                {loading && key !== "Ie" ? (
                  <>
                    <div className="mb-1.5 h-3 w-14 animate-pulse rounded bg-slate-200" />
                    <div className="h-6 w-20 animate-pulse rounded bg-slate-200" />
                  </>
                ) : (
                  <>
                    <p className="flex items-center gap-1 text-xs font-medium text-slate-600">
                      {labels[key]}
                      <InfoTip text={tooltips[key]} ariaLabel={longDesc[key]} align={key === "SDS" ? "start" : undefined} />
                    </p>
                    <p className="mt-0.5 tabular-nums text-base font-semibold text-slate-900">
                      {displayWithUnit}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">{longDesc[key]}</p>
                    {deltaStr && (
                      <p className="mt-0.5 text-xs text-slate-400 tabular-nums">{deltaStr}</p>
                    )}
                    {showChanged && (
                      <p className="mt-0.5 text-xs text-slate-400">Changed</p>
                    )}
                  </>
                )}
              </div>
            );
          })}
          </div>

          {/* Request details (collapsible) */}
          {(lastApiUrl || lastUpdatedAt || (data && Number.isFinite(data.vs30))) && (
            <div className="border-t border-slate-200 px-4 py-2">
              <button
                type="button"
                onClick={() => setRequestDetailsOpen((o) => !o)}
                className="flex w-full items-center justify-between gap-2 py-1.5 text-left text-sm text-slate-600 hover:text-slate-900"
              >
                Request Details
                <span className="text-slate-400">{requestDetailsOpen ? "▲" : "▼"}</span>
              </button>
              {requestDetailsOpen && (
                <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
                  {lastApiUrl && (
                    <div>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-slate-500">URL:</span>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(lastApiUrl);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            } catch {}
                          }}
                          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-sans font-medium text-slate-600 hover:bg-slate-50"
                        >
                          {copied ? "Copied!" : "Copy"}
                        </button>
                      </div>
                      <pre className="whitespace-pre-wrap break-all rounded border border-slate-200 bg-white px-2 py-1.5">{lastApiUrl}</pre>
                    </div>
                  )}
                  {lastUpdatedAt && (
                    <div>
                      <span className="text-slate-500">Last fetch:</span> {lastUpdatedAt.toISOString()}
                    </div>
                  )}
                  {data && Number.isFinite(data.vs30) && (
                    <div>
                      <span className="text-slate-500">vs30:</span> {data.vs30}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Base Shear (ELF) Calculator */}
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
            <div>
              <h2 className="text-base font-medium text-slate-900">Base Shear (ELF) Calculator</h2>
              <p className="text-xs text-slate-500">Screening-level equivalent lateral force using ASCE 7-22</p>
            </div>
            <button
              type="button"
              className="no-print rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              onClick={() => {
                setElfR(8);
                setElfW("");
                setElfT("");
                setElfS1Override("");
                setElfIeOverride(false);
                setElfIeOverrideVal(1);
              }}
            >
              Reset to Default
            </button>
          </div>
          <div className="p-4">
            {!data ? (
              <p className="text-sm text-slate-500">Select a location to load SDS, SD1, and Ts from USGS.</p>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
                  <div>
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                      Response modification coefficient (R)
                      <InfoTip text="Response modification coefficient from ASCE 7-22 based on lateral-force-resisting system. Higher R → lower design forces." />
                    </label>
                    <input
                      type="number"
                      step={0.1}
                      min={1}
                      value={elfR}
                      onChange={(e) => setElfR(Math.max(1, parseFloat(e.target.value) || 1))}
                      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                      Effective seismic weight (W, kips)
                      <InfoTip text="Effective seismic weight in kips. Typically dead load + applicable portions of live and other loads. Must be > 0 for base shear. Max 1,000,000." />
                    </label>
                    <input
                      type="number"
                      step={1}
                      min={1}
                      max={1000000}
                      value={elfW}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") setElfW("");
                        else {
                          const n = parseFloat(v);
                          setElfW(Number.isFinite(n) ? Math.max(1, Math.min(1000000, n)) : elfW);
                        }
                      }}
                      placeholder="e.g. 5000"
                      className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                        elfW !== "" && (typeof elfW !== "number" || elfW < 1 || elfW > 1000000)
                          ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                          : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                      }`}
                    />
                    {elfW !== "" && typeof elfW === "number" && (elfW < 1 || elfW > 1000000) && (
                      <p className="mt-0.5 text-xs text-amber-600">Enter 1–1,000,000 kips (W must be &gt; 0)</p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                      Fundamental period (T, s)
                      <InfoTip text="Fundamental period in seconds. Can be approximate (Ct·h^x) or from analysis. Min 0.05, max 10." />
                    </label>
                    <input
                      type="number"
                      step={0.01}
                      min={0.05}
                      max={10}
                      value={elfT}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") setElfT("");
                        else {
                          const n = parseFloat(v);
                          setElfT(Number.isFinite(n) ? Math.max(0.05, Math.min(10, n)) : elfT);
                        }
                      }}
                      placeholder="e.g. 0.5"
                      className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                        elfT !== "" && (typeof elfT !== "number" || elfT < 0.05 || elfT > 10)
                          ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                          : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                      }`}
                    />
                    {elfT !== "" && typeof elfT === "number" && (elfT < 0.05 || elfT > 10) && (
                      <p className="mt-0.5 text-xs text-amber-600">Enter 0.05–10 s</p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                      S1 (MCEr), g override
                      <InfoTip text="S1 is mapped MCER spectral acceleration at 1s (reference rock). Used for 0.5·S1·Ie/R minimum base shear. Min 0, max 3g. Leave blank to use site value." />
                    </label>
                    <input
                      type="number"
                      step={0.01}
                      min={0}
                      max={3}
                      value={elfS1Override}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") setElfS1Override("");
                        else {
                          const n = parseFloat(v);
                          setElfS1Override(Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : elfS1Override);
                        }
                      }}
                      placeholder={effectiveS1 != null ? String(effectiveS1.toFixed(3)) : "optional"}
                      className={`w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                        elfS1Override !== "" && typeof elfS1Override === "number" && (elfS1Override < 0 || elfS1Override > 3)
                          ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500"
                          : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                      }`}
                    />
                    {elfS1Override !== "" && typeof elfS1Override === "number" && (elfS1Override < 0 || elfS1Override > 3) && (
                      <p className="mt-0.5 text-xs text-amber-600">Enter 0–3g</p>
                    )}
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                      Importance factor (Ie)
                      <InfoTip text="Importance factor from Risk Category (I–IV). Min 1.0, max 1.5. Higher Ie → higher design forces." />
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        step={0.01}
                        min={1}
                        max={1.5}
                        value={elfIeOverride ? elfIeOverrideVal : getIe(riskCategory)}
                        onChange={(e) => setElfIeOverrideVal(Math.max(1, Math.min(1.5, parseFloat(e.target.value) || 1)))}
                        disabled={!elfIeOverride}
                        className="w-20 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-100 disabled:text-slate-500"
                      />
                      <label className="flex items-center gap-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={elfIeOverride}
                          onChange={(e) => {
                            const on = e.target.checked;
                            setElfIeOverride(on);
                            if (on) setElfIeOverrideVal(getIe(riskCategory));
                          }}
                          className="rounded border-slate-300"
                        />
                        Override
                      </label>
                      {!elfIeOverride && (
                        <span className="text-xs text-slate-500">(from Risk Cat.)</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
                  {elfResult ? (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Cs (seismic response coefficient)</p>
                          <p className="mt-0.5 text-lg font-semibold text-slate-900">{formatNum(elfResult.csFinal, 4)}</p>
                          <p className="mt-1 text-xs text-slate-600">
                            {elfResult.branch === "SDS"
                              ? `Cs = SDS·Ie/R = ${formatNum(data!.sds, 3)}×${elfIe}/${elfR}`
                              : (() => {
                                  const tVal = typeof elfT === "number" ? elfT : parseFloat(String(elfT));
                                  return `Cs = SD1·Ie/(T·R) = ${formatNum(data!.sd1, 3)}×${elfIe}/(${Number.isFinite(tVal) ? tVal.toFixed(2) : "T"}×${elfR})`;
                                })()}
                            {" "}
                            <span className="text-slate-500">({elfResult.branch === "SDS" ? "T ≤ Ts" : "T &gt; Ts"})</span>
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">V = Cs·W (base shear, kips)</p>
                          <p className="mt-0.5 text-lg font-semibold text-slate-900">{formatV(elfResult.v)}</p>
                          <p className="mt-1 text-xs text-slate-600">
                            V = {formatNum(elfResult.csFinal, 4)} × {typeof elfW === "number" ? formatV(elfW) : "W"} = {formatV(elfResult.v)} kips
                          </p>
                        </div>
                      </div>
                      <details className="text-xs text-slate-600">
                        <summary className="cursor-pointer font-medium text-slate-700">Show intermediate values</summary>
                        <div className="mt-2 space-y-1 border-t border-slate-200 pt-2">
                          <p>Cs (raw): {formatNum(elfResult.csRaw, 4)} · Cs_min: {formatNum(elfResult.csMin, 4)} ({elfResult.minControlled})</p>
                          {elfResult.maxApplicable && elfResult.csMax != null && (
                            <p>Cs_max (T &gt; Ts cap): {formatNum(elfResult.csMax, 4)}</p>
                          )}
                        </div>
                      </details>
                    </>
                  ) : (
                    <p className="text-sm text-slate-500">
                      Enter W (effective seismic weight, kips) and T (fundamental period, s) to compute base shear. Values must be within valid ranges.
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Screening only. Final ASCE 7-22 ELF requires additional checks (period limits, system selection, vertical distribution, etc.).
                </p>
              </>
            )}
          </div>
        </div>

        {/* Risk Category Compare */}
        {rcCompareData && (
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="text-base font-medium text-slate-900">Risk Category Compare</h2>
              <p className="text-xs text-slate-500">RC II vs RC IV — {locationLabel}, Site Class {siteClass}</p>
            </div>
            <div className="p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Risk Category II</h3>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-slate-500">Ie</span><span className="ml-2 font-semibold">1.0</span></div>
                    <div><span className="text-slate-500">SDC</span><span className="ml-2 font-semibold">{rcCompareData.ii.sdc}</span></div>
                    <div><span className="text-slate-500">SDS</span><span className="ml-2 font-semibold">{rcCompareData.ii.sds.toFixed(3)}g</span></div>
                    <div><span className="text-slate-500">SD1</span><span className="ml-2 font-semibold">{rcCompareData.ii.sd1.toFixed(3)}g</span></div>
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Risk Category IV</h3>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-slate-500">Ie</span>
                      <span className="ml-2 font-semibold text-emerald-600">1.5</span>
                    </div>
                    <div>
                      <span className="text-slate-500">SDC</span>
                      <span className={`ml-2 font-semibold ${rcCompareData.ii.sdc !== rcCompareData.iv.sdc ? "text-emerald-600" : ""}`}>{rcCompareData.iv.sdc}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">SDS</span>
                      <span className={`ml-2 font-semibold ${rcCompareData.ii.sds === rcCompareData.iv.sds ? "text-slate-400" : ""}`}>
                        {rcCompareData.iv.sds.toFixed(3)}g
                        {rcCompareData.ii.sds === rcCompareData.iv.sds && " (unchanged)"}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">SD1</span>
                      <span className={`ml-2 font-semibold ${rcCompareData.ii.sd1 === rcCompareData.iv.sd1 ? "text-slate-400" : ""}`}>
                        {rcCompareData.iv.sd1.toFixed(3)}g
                        {rcCompareData.ii.sd1 === rcCompareData.iv.sd1 && " (unchanged)"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Ie and SDC vary with Risk Category. SDS and SD1 typically remain unchanged (USGS hazard by location + site class).
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Spectrum chart */}
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
              <div>
                <h2 className="flex items-center gap-1.5 text-base font-medium text-slate-900">
                  {spectrumType === "design" ? "Design" : "MCEr"} Response Spectrum
                  <span className="group/spectrum relative inline-flex">
                    <span
                      tabIndex={0}
                      role="button"
                      aria-label="Spectral acceleration (g) vs. period (s). Shows design or MCER Sa; use for structural analysis and modal response."
                      className="cursor-pointer text-slate-400 hover:text-slate-600 focus:outline focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded"
                      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).focus()}
                    >
                      ⓘ
                    </span>
                    <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 w-56 rounded bg-slate-800 px-2 py-1.5 text-xs leading-relaxed text-white opacity-0 shadow-xl transition-opacity group-hover/spectrum:opacity-100 group-focus-within/spectrum:opacity-100">
                      Spectral acceleration (g) vs. period (s). Shows design or MCER Sa; use for structural analysis and modal response.
                    </span>
                  </span>
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {spectrumType === "design"
                    ? "Design spectral acceleration (Sa) vs. period"
                    : "MCER spectral acceleration vs. period"}
                  {" — "}
                  {locationLabel}, Site Class {siteClass}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-md bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setSpectrumType("design")}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                      spectrumType === "design" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Design
                  </button>
                  <button
                    type="button"
                    onClick={() => setSpectrumType("mcer")}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                      spectrumType === "mcer" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    MCEr
                  </button>
                </div>
                <div className="inline-flex rounded-md bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setSpectrumXScale("log")}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                      spectrumXScale === "log" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Log
                  </button>
                  <button
                    type="button"
                    onClick={() => setSpectrumXScale("linear")}
                    className={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
                      spectrumXScale === "linear" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Linear
                  </button>
                </div>
              </div>
              {spectrumXScale === "log" && (
                <p className="mt-1 text-xs text-slate-400">Log view starts at T=0.01s.</p>
              )}
            </div>
            <div className="p-4">
              <div className="h-[280px] min-h-[280px]">
                {loading ? (
                  <div className="flex h-full flex-col gap-4 p-2">
                    <div className="flex justify-between">
                      <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
                      <div className="h-4 w-16 animate-pulse rounded bg-slate-200" />
                    </div>
                    <div className="flex-1 space-y-2">
                      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                        <div key={i} className="h-8 w-full animate-pulse rounded bg-slate-100" style={{ width: `${100 - i * 8}%` }} />
                      ))}
                    </div>
                    <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
                  </div>
                ) : spectrumChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={spectrumChartData} margin={{ top: 24, right: 20, left: 12, bottom: 24 }}>
                      <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" vertical={false} strokeOpacity={0.6} />
                      <XAxis
                        dataKey="period"
                        type="number"
                        scale={spectrumXScale}
                        domain={spectrumXScale === "log" ? [0.01, "dataMax"] : ["auto", "auto"]}
                        ticks={spectrumXScale === "log" ? [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.2, 0.5, 1, 2, 5, 10] : undefined}
                        tickFormatter={spectrumXScale === "log" ? (t: number) => String(t) : undefined}
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        label={{
                          value: "Period, T (s)",
                          position: "insideBottom",
                          offset: -2,
                          style: { fontSize: 12, fill: "#64748b", fontWeight: 500 },
                        }}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        tickFormatter={(v) => `${v} g`}
                        label={{
                          value: "Sa (g)",
                          angle: -90,
                          position: "insideLeft",
                          style: { fontSize: 12, fill: "#64748b", fontWeight: 500 },
                        }}
                      />
                      {data && Number.isFinite(data.t0) && (
                        <ReferenceLine
                          x={data.t0}
                          stroke="#64748b"
                          strokeWidth={1}
                          strokeDasharray="4 2"
                          label={{ value: "T₀", position: "insideTopLeft", fill: "#64748b", fontSize: 10, offset: 4 }}
                        />
                      )}
                      {data && Number.isFinite(data.ts) && (
                        <ReferenceLine
                          x={data.ts}
                          stroke="#64748b"
                          strokeWidth={1}
                          strokeDasharray="4 2"
                          label={{ value: "Ts", position: "insideTopRight", fill: "#64748b", fontSize: 10, offset: 4 }}
                        />
                      )}
                      {data && Number.isFinite(data.tl) && data.tl <= 10 && (
                        <ReferenceLine
                          x={data.tl}
                          stroke="#94a3b8"
                          strokeWidth={1}
                          strokeDasharray="4 2"
                          label={{ value: "TL", position: "insideBottomRight", fill: "#94a3b8", fontSize: 10, offset: 4 }}
                        />
                      )}
                      <Tooltip
                        formatter={(v: number) => [
                          `${Number(v).toFixed(3)} g`,
                          spectrumType === "design" ? "Sa (design)" : "Sa (MCER)",
                        ]}
                        labelFormatter={(l) => {
                          const t = Number(l);
                          const decimals = t < 1 ? 3 : 2;
                          return `Period T = ${t.toFixed(decimals)} s`;
                        }}
                        contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                        itemStyle={{ fontWeight: 600 }}
                      />
                      <Line
                        type="linear"
                        dataKey="Sa"
                        stroke="#475569"
                        strokeWidth={2}
                        dot={false}
                        name="Sa (g)"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
                    <span className="text-4xl opacity-50">📊</span>
                    <span className="text-sm">Select a location to load spectrum data</span>
                  </div>
                )}
              </div>
              {hasVerticalSpectrum && (
                <div className="border-t border-slate-200 px-4 py-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-sm font-medium text-slate-700 hover:text-slate-900"
                    onClick={() => setVerticalSpectrumOpen((o) => !o)}
                    aria-expanded={verticalSpectrumOpen}
                  >
                    Vertical Spectrum (Sa,v)
                    <span>{verticalSpectrumOpen ? "▾" : "▸"}</span>
                  </button>
                  {verticalSpectrumOpen && (
                    <div className="mt-2 h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={verticalSpectrumChartData} margin={{ top: 8, right: 12, left: 8, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" vertical={false} strokeOpacity={0.6} />
                          <XAxis dataKey="period" type="number" scale={spectrumXScale} domain={spectrumXScale === "log" ? [0.01, "dataMax"] : ["auto", "auto"]} tick={{ fontSize: 10, fill: "#64748b" }} />
                          <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => `${v} g`} />
                          <Tooltip formatter={(v: number) => [`${Number(v).toFixed(3)} g`, "Sa,v (g)"]} />
                          <Line type="linear" dataKey="Sa" stroke="#64748b" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Site Class Sensitivity */}
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-2.5">
              <h2 className="flex items-center gap-1.5 text-base font-medium text-slate-900">
                Site Class Sensitivity ({sensitivityMetric})
                <span className="group/sensitivity relative inline-flex">
                  <span
                    tabIndex={0}
                    role="button"
                    aria-label="Compare SDS or SD1 across site classes (g). Use to understand geotech impact and inform site-specific studies."
                    className="cursor-pointer text-slate-400 hover:text-slate-600 focus:outline focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 rounded"
                    onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).focus()}
                  >
                    ⓘ
                  </span>
                  <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 w-56 rounded bg-slate-800 px-2 py-1.5 text-xs leading-relaxed text-white opacity-0 shadow-xl transition-opacity group-hover/sensitivity:opacity-100 group-focus-within/sensitivity:opacity-100">
                    Compare SDS or SD1 across site classes (g). Use to understand geotech impact and inform site-specific studies.
                  </span>
                </span>
              </h2>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                {sensitivityMetric} by site class — {locationLabel}
                {sensitivityData && sensitivityData.length > 0 && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-600">Reference: {sensitivityRefClass}</span>
                )}
              </p>
            </div>
            <div className="p-4">
              {sensitivityData && sensitivityData.length > 0 && !sensitivityLoading && (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-600">
                    Loaded {sensitivityData.length}/{siteClassesForCompare.length}
                  </span>
                  {sensitivityFailedClasses.length > 0 && (
                    <span className="text-amber-600">Failed: {sensitivityFailedClasses.join(", ")}</span>
                  )}
                </div>
              )}
              <div className="h-[280px] min-h-[280px]">
                {sensitivityLoading ? (
                  <div className="flex h-full flex-col justify-end gap-2 px-2">
                    {[0.4, 0.6, 0.8, 0.7, 0.9, 0.5].map((h, i) => (
                      <div
                        key={i}
                        className="animate-pulse rounded-md bg-slate-200"
                        style={{ height: `${h * 60}%`, minHeight: 24 }}
                      />
                    ))}
                  </div>
                ) : sensitivityChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={sensitivityChartData} margin={{ top: 24, right: 20, left: 12, bottom: 24 }}>
                      <CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" vertical={false} strokeOpacity={0.6} />
                      <XAxis
                        dataKey="siteClass"
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        label={{
                          value: "Site Class",
                          position: "insideBottom",
                          offset: -2,
                          style: { fontSize: 12, fill: "#64748b", fontWeight: 500 },
                        }}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        label={{
                          value: `${sensitivityMetric} (g)`,
                          angle: -90,
                          position: "insideLeft",
                          style: { fontSize: 12, fill: "#64748b", fontWeight: 500 },
                        }}
                      />
                      <Tooltip
                        formatter={(v: number, _name: string, props: { payload?: { siteClass: string; value: number } }) => {
                          const val = Number(v);
                          const sc = props.payload?.siteClass ?? "";
                          const row = sensitivityData?.find((r) => r.siteClass === sc);
                          const sdsVal = row?.sds;
                          const sd1Val = row?.sd1;
                          const detail = sdsVal != null && sd1Val != null
                            ? `SDS ${sdsVal.toFixed(3)}g, SD1 ${sd1Val.toFixed(3)}g`
                            : `${sensitivityMetric} ${val.toFixed(3)}g`;
                          return [detail, `${sensitivityMetric} (g)`];
                        }}
                        contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                        itemStyle={{ fontWeight: 600 }}
                        labelFormatter={(label) => `Site Class ${label}`}
                      />
                      <Bar
                        dataKey="value"
                        radius={[4, 4, 0, 0]}
                        name={`${sensitivityMetric} (g)`}
                      >
                        {sensitivityChartData.map((entry) => (
                          <Cell
                            key={entry.siteClass}
                            fill={entry.siteClass === siteClass ? "#334155" : "#94a3b8"}
                            stroke={entry.siteClass === siteClass ? "#1e293b" : undefined}
                            strokeWidth={entry.siteClass === siteClass ? 1.5 : 0}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
                    <span className="text-4xl opacity-50">📈</span>
                    <span className="text-sm">Sensitivity data will load with your selection</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Interpretation */}
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-2.5">
            <h2 className="text-base font-medium text-slate-900">Interpretation</h2>
            <p className="text-xs text-slate-500">Summary, Key Parameters, and Next Steps for {locationLabel}</p>
          </div>
          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Summary</h3>
              <ul className="space-y-1.5 text-sm text-slate-700">
                {insights.whatItMeans.map((item, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>{item.label}</span>
                    {item.value != null && <span className="font-medium text-slate-900">{item.value}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Key Parameters</h3>
              <ul className="space-y-1.5 text-sm text-slate-700">
                {insights.keyFindings.map((item, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>{item.label}</span>
                    {item.value != null && <span className="font-medium text-slate-900">{item.value}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Next Steps</h3>
              <ul className="space-y-1.5 text-sm text-slate-700">
                {insights.nextSteps.map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-slate-400">•</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
