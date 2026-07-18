import { URGENCY_RED_MS, URGENCY_YELLOW_MS } from "../constants.js";

export function getStatus(item, now) {
  const gapHours = item.timingModel === "scheduled" ? item.intervalHours : item.minGapHours;
  const elapsed = now - item.lastDone;
  const remaining = item.lastDone + gapHours * 3600 * 1000 - now;
  const ready = remaining <= 0;
  const stage = ready ? "ready" : remaining <= URGENCY_RED_MS ? "red" : remaining <= URGENCY_YELLOW_MS ? "yellow" : "green";
  const color = stage === "ready" ? "#5FA663" : stage === "red" ? "#C67B6C" : stage === "yellow" ? "#C99A4E" : "#5FA663";
  const label = ready
    ? (item.timingModel === "scheduled" ? "Ready now" : "Available now")
    : (item.timingModel === "scheduled" ? "Next due in" : "Next available in");
  return { elapsed, remaining, ready, color, stage, label };
}

export const fmtCountdown = (ms) => {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m >= 10) return `${m}m`;
  return `${m}:${String(s).padStart(2, "0")}`; // under 10 minutes — count down by the second
};

export const fmtElapsed = (ms) => {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
};
