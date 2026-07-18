export const dateKey = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

// Turns a native time input's "HH:MM" value into something natural to speak, e.g. "3:45 PM".
export const formatTimeForSpeech = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

export function nextOccurrence(timestamp, recurrence, now) {
  let ts = timestamp;
  while (ts <= now) {
    if (recurrence === "weekly") {
      ts += 7 * 24 * 3600 * 1000;
    } else if (recurrence === "monthly") {
      const nd = new Date(ts);
      nd.setMonth(nd.getMonth() + 1);
      ts = nd.getTime();
    } else {
      break; // shouldn't happen — "none" recurrence never rolls forward
    }
  }
  return ts;
}

export function formatEntryDate(dateStr) {
  if (!dateStr) return "—"; // entries logged before this field existed won't have one
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d - today) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function timeDisplayTo24h(display) {
  const m = String(display || "").match(/(\d+):(\d+)\s*([AP]M)/i);
  if (!m) return "12:00";
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

export function time24hToDisplay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
