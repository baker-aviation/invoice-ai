// ---------------------------------------------------------------------------
// Ground Pipeline — stages, categories, types, and helpers
// ---------------------------------------------------------------------------

/** Base ground pipeline stages (all roles go through these) */
export const GROUND_PIPELINE_STAGES = [
  "screening",
  "phone_screen",
  "interview",
  "manager_review",
  "background_check",
  "offer",
  "hired",
] as const;

export type GroundPipelineStage = (typeof GROUND_PIPELINE_STAGES)[number] | "technical_assessment" | "sales_exercise" | "driving_record_check";

/** All possible ground stages including role-specific ones */
export const ALL_GROUND_STAGES: readonly string[] = [
  "screening",
  "phone_screen",
  "sales_exercise",
  "technical_assessment",
  "interview",
  "manager_review",
  "driving_record_check",
  "background_check",
  "offer",
  "hired",
];

/** Categories that belong to the ground pipeline */
export const GROUND_CATEGORIES = [
  "maintenance",
  "sales",
  "admin",
  "management",
  "line_service",
  "other",
] as const;

export type GroundCategory = (typeof GROUND_CATEGORIES)[number];

/** Extra stages inserted per role category */
const GROUND_ROLE_EXTRA_STAGES: Record<string, { stage: string; before: string }[]> = {
  maintenance: [{ stage: "technical_assessment", before: "manager_review" }],
  sales: [{ stage: "sales_exercise", before: "interview" }],
  management: [{ stage: "driving_record_check", before: "background_check" }],
};

/** Get the correct stage sequence for a given ground category */
export function getGroundStagesForCategory(category: string | null): string[] {
  const base: string[] = [...GROUND_PIPELINE_STAGES];
  const extras = GROUND_ROLE_EXTRA_STAGES[category ?? ""];
  if (!extras) return base;

  for (const { stage, before } of extras) {
    const idx = base.indexOf(before);
    if (idx >= 0) {
      base.splice(idx, 0, stage);
    }
  }
  return base;
}

/** Check if a category is a ground category */
export function isGroundCategory(category: string | null | undefined): boolean {
  return (GROUND_CATEGORIES as readonly string[]).includes(category ?? "");
}

/** Check if a stage is valid for a given ground category */
export function isValidGroundStage(stage: string, category: string | null): boolean {
  return getGroundStagesForCategory(category).includes(stage);
}

/** Display metadata for each ground stage */
export const GROUND_STAGE_META: Record<string, { label: string; subtitle?: string; color: string; headerColor: string }> = {
  screening: {
    label: "Screening",
    color: "border-teal-200",
    headerColor: "bg-teal-100 text-teal-700",
  },
  phone_screen: {
    label: "Phone Screen",
    color: "border-cyan-200",
    headerColor: "bg-cyan-100 text-cyan-700",
  },
  sales_exercise: {
    label: "Sales Exercise",
    color: "border-pink-200",
    headerColor: "bg-pink-100 text-pink-700",
  },
  technical_assessment: {
    label: "Technical Assessment",
    color: "border-amber-200",
    headerColor: "bg-amber-100 text-amber-700",
  },
  interview: {
    label: "Interview",
    subtitle: "Dropping here sends scheduling email (if configured)",
    color: "border-violet-200",
    headerColor: "bg-violet-100 text-violet-700",
  },
  manager_review: {
    label: "Manager Review",
    subtitle: "Requires approval to advance",
    color: "border-orange-200",
    headerColor: "bg-orange-100 text-orange-700",
  },
  driving_record_check: {
    label: "Driving Record",
    color: "border-slate-200",
    headerColor: "bg-slate-100 text-slate-700",
  },
  background_check: {
    label: "Background Check",
    color: "border-indigo-200",
    headerColor: "bg-indigo-100 text-indigo-700",
  },
  offer: {
    label: "Offer",
    color: "border-emerald-200",
    headerColor: "bg-emerald-100 text-emerald-700",
  },
  hired: {
    label: "Hired",
    color: "border-green-200",
    headerColor: "bg-green-100 text-green-700",
  },
};

/** Category display labels */
export const GROUND_CATEGORY_LABELS: Record<string, string> = {
  maintenance: "A&P / Mx",
  sales: "Sales",
  admin: "Admin",
  management: "Mgmt",
  line_service: "Line Svc",
  other: "Other",
};

/** Category color classes */
export const GROUND_CATEGORY_COLORS: Record<string, string> = {
  maintenance: "bg-amber-100 text-amber-800 border-amber-200",
  sales: "bg-pink-100 text-pink-800 border-pink-200",
  admin: "bg-slate-100 text-slate-700 border-slate-200",
  management: "bg-orange-100 text-orange-800 border-orange-200",
  line_service: "bg-teal-100 text-teal-800 border-teal-200",
  other: "bg-gray-100 text-gray-600 border-gray-200",
};

/** Category options for dropdowns */
export const GROUND_CATEGORY_OPTIONS = [
  { value: "maintenance", label: "A&P Mechanic / Maintenance" },
  { value: "sales", label: "Sales" },
  { value: "management", label: "Fleet Manager / Management" },
  { value: "line_service", label: "Line Service / Ramp" },
  { value: "admin", label: "Admin / Office" },
  { value: "other", label: "Other" },
];
