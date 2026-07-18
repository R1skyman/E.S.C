import {
  Pill, Utensils, Wind, HeartPulse, GraduationCap, Moon, CalendarDays, Sparkles,
  Crown, Shield, Eye as EyeIcon,
} from "lucide-react";

export const CATEGORY_META = {
  medication: { label: "Medication", icon: Pill, color: "#4A7FAE" },
  meal: { label: "Meal", icon: Utensils, color: "#C99A4E" },
  sensory: { label: "Sensory", icon: Wind, color: "#7BA88A" },
  therapy: { label: "Therapy", icon: HeartPulse, color: "#B4718A" },
  sleep: { label: "Sleep", icon: Moon, color: "#8A7FC4" },
  school: { label: "School", icon: GraduationCap, color: "#4A96A3" },
  appointment: { label: "Appointment", icon: CalendarDays, color: "#C97B5A" },
  activity: { label: "Activity", icon: Sparkles, color: "#7A9E5C" },
};

// A frozen snapshot of the original design-system colors, taken before any user override is ever
// applied — this is what "Reset to default" restores, and what an un-set category falls back to.
export const DEFAULT_CATEGORY_COLORS = Object.fromEntries(Object.entries(CATEGORY_META).map(([k, v]) => [k, v.color]));

// Based on the Okabe–Ito palette (Okabe & Ito, "Color Universal Design", 2008), one of the most
// widely-used colorblind-safe palettes — adapted slightly (a darker gold instead of pure yellow,
// a dark gray instead of pure black) since these render as thin icon strokes on a white background.
export const COLORBLIND_PALETTE = {
  medication: "#0072B2", meal: "#E69F00", sensory: "#009E73", therapy: "#CC79A7",
  sleep: "#56B4E9", school: "#D55E00", appointment: "#B8860B", activity: "#595959",
};

export const ROLE_META = {
  owner: { label: "Owner", icon: Crown, color: "#C99A4E", description: "Everything Full access can do, plus can change anyone's permissions, remove people, and delete the household." },
  full: { label: "Full access", icon: Shield, color: "#4A7FAE", description: "Can log entries, edit schedules, add children, manage Info Bank, and invite others. Can't change permissions or remove people." },
  view: { label: "View only", icon: EyeIcon, color: "#8A94A0", description: "Can see everything — schedules, history, bios, contacts — but can't add, edit, or delete anything." },
};

export const URGENCY_RED_MS = 10 * 60 * 1000; // under 10 minutes left
export const URGENCY_YELLOW_MS = 2 * 3600 * 1000; // under 2 hours left

// No seed data: a fresh install has no household until the user creates one
// via the "Create a household" flow.
export const DEFAULT_HOUSEHOLDS = [];
