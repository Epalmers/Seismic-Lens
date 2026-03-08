/**
 * ELF Base Shear Calculator (screening-level)
 * ASCE 7-22 equivalent lateral force method
 */

// ASCE 7-22 Table 11.8-2: Site coefficient Fv (long-period)
// Rows: site class, Cols: S1 ≤0.1, 0.1-0.2, 0.2-0.3, 0.3-0.4, 0.4-0.5, >0.5
const FV_TABLE: Record<string, number[]> = {
  A: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
  B: [0.4, 0.4, 0.5, 0.5, 0.5, 0.5],
  C: [0.5, 0.5, 0.6, 0.6, 0.5, 0.5],
  D: [0.6, 0.8, 1.0, 1.1, 1.2, 1.2],
  E: [0.6, 0.8, 1.1, 1.3, 1.5, 1.5],
  // Intermediates: use more conservative (higher Fv → lower S1) or average
  Default: [0.6, 0.8, 1.0, 1.1, 1.2, 1.2],
  BC: [0.45, 0.45, 0.55, 0.55, 0.5, 0.5],
  CD: [0.55, 0.65, 0.8, 0.85, 0.85, 0.85],
  DE: [0.6, 0.8, 1.05, 1.2, 1.35, 1.35],
};

function getFvForS1(siteClass: string, s1: number): number {
  const row = FV_TABLE[siteClass] ?? FV_TABLE.D;
  let idx = 0;
  if (s1 <= 0.1) idx = 0;
  else if (s1 <= 0.2) idx = 1;
  else if (s1 <= 0.3) idx = 2;
  else if (s1 <= 0.4) idx = 3;
  else if (s1 <= 0.5) idx = 4;
  else idx = 5;
  return row[idx];
}

/**
 * Back-calculate S1 from SD1 using S1 = SD1 / Fv.
 * ASCE 7-22: SD1 = Fv * S1. Fv depends on S1 (Table 11.8-2), so we iterate.
 */
export function computeS1FromSD1(sd1: number, siteClass: string): number | null {
  if (!Number.isFinite(sd1) || sd1 <= 0) return null;
  let s1 = sd1; // initial guess (Fv ≈ 1)
  for (let i = 0; i < 10; i++) {
    const fv = getFvForS1(siteClass, s1);
    if (fv <= 0) return null;
    const s1New = sd1 / fv;
    if (Math.abs(s1New - s1) < 1e-6) return s1New;
    s1 = s1New;
  }
  return s1;
}

export interface ElfInputs {
  sds: number;
  sd1: number;
  ts: number;
  sdc: string;
  ie: number;
  r: number;
  w: number;
  t: number;
  s1Override: number | null;
}

export interface ElfResult {
  csRaw: number;
  csMin: number;
  csMax: number | null;
  csFinal: number;
  v: number;
  branch: "SDS" | "SD1";
  minControlled: "0.044*Ie" | "0.01*Ie" | "0.5*S1*Ie/R" | "none";
  maxApplicable: boolean;
}

const SDC_FACTOR = 1.0; // screening: same for A–F

export function computeElf(inputs: ElfInputs): ElfResult | null {
  const { sds, sd1, ts, sdc, ie, r, w, t, s1Override } = inputs;

  if (!Number.isFinite(w) || w <= 0) return null;
  if (!Number.isFinite(t) || t <= 0) return null;
  if (!Number.isFinite(r) || r <= 0) return null;
  if (!Number.isFinite(sds) || !Number.isFinite(sd1) || !Number.isFinite(ts)) return null;
  if (!Number.isFinite(ie) || ie <= 0) return null;

  const branch: "SDS" | "SD1" = t <= ts ? "SDS" : "SD1";

  let csRaw: number;
  if (t <= ts) {
    csRaw = (sds * ie) / r;
  } else {
    csRaw = (sd1 * ie) / (t * r);
  }

  let csMax: number | null = null;
  if (t > ts) {
    csMax = (sds * ie) / r;
  }

  const csMin1 = 0.044 * SDC_FACTOR * ie;
  const csMin2 = 0.01 * ie;

  let csMin3: number | null = null;
  const s1 = s1Override ?? null;
  if (s1 != null && Number.isFinite(s1) && s1 > 0) {
    csMin3 = (0.5 * s1 * ie) / r;
  }

  const mins: { val: number; label: "0.044*Ie" | "0.01*Ie" | "0.5*S1*Ie/R" }[] = [
    { val: csMin1, label: "0.044*Ie" },
    { val: csMin2, label: "0.01*Ie" },
  ];
  if (csMin3 != null) mins.push({ val: csMin3, label: "0.5*S1*Ie/R" });

  const csMin = Math.max(...mins.map((m) => m.val));
  const minControlled = mins.find((m) => Math.abs(m.val - csMin) < 1e-9)?.label ?? "none";

  let csFinal = Math.max(csRaw, csMin);
  if (csMax != null) {
    csFinal = Math.min(csFinal, csMax);
  }

  const v = csFinal * w;

  return {
    csRaw,
    csMin,
    csMax,
    csFinal,
    v,
    branch,
    minControlled,
    maxApplicable: csMax != null,
  };
}

export function formatNum(val: number, decimals: number): string {
  if (!Number.isFinite(val)) return "—";
  return val.toFixed(decimals);
}

export function formatV(val: number): string {
  if (!Number.isFinite(val)) return "—";
  return Math.round(val).toLocaleString();
}
