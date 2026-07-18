import { CATEGORY_META } from "../constants.js";
import { dateKey, addDays, formatEntryDate } from "./dateHelpers.js";

// A real UUID, not just a locally-unique token: several entities (children, care
// items, timeline entries, ...) insert this id directly as a Postgres uuid primary
// key, generated client-side so callers can use it immediately without waiting on
// a round trip back from the database.
export const uid = () => crypto.randomUUID();

export function formatPhoneInput(raw) {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length < 4) return digits.length ? `(${digits}` : "";
  if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function buildHistorySummary(timeline, childName, days = 30) {
  const lines = [`${childName}'s care history — last ${days} days`, ""];
  let anyEntries = false;
  for (let offset = 0; offset >= -(days - 1); offset--) {
    const key = dateKey(addDays(new Date(), offset));
    const entries = timeline[key];
    if (!entries || entries.length === 0) continue;
    anyEntries = true;
    lines.push(formatEntryDate(key) + ` (${key}):`);
    for (const e of entries) {
      const meta = CATEGORY_META[e.category] || CATEGORY_META.medication;
      lines.push(`  • ${e.time} — ${e.title}${e.subtitle ? `, ${e.subtitle}` : ""} [${meta.label}]${e.loggedBy ? ` — logged by ${e.loggedBy}` : ""}`);
    }
    lines.push("");
  }
  if (!anyEntries) lines.push("(No entries logged in this period.)");
  return lines.join("\n");
}

export function hoursToUnitDefault(hours) {
  if (!(hours > 0)) return { unit: "hours", value: "" };
  const mins = Math.round(hours * 60);
  if (hours < 1) return { unit: "minutes", value: String(mins) };
  return { unit: "hours", value: String(hours) };
}
