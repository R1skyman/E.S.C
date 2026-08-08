export const dateKey = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

// Turns a native time input's "HH:MM" value into something natural to speak, e.g. "3:45 PM".
// Deliberately always spoken in 12h form regardless of the display format setting — "fourteen
// hundred" isn't how people naturally say times aloud, even if they prefer seeing 24h on screen.
export const formatTimeForSpeech = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
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

// Parses a *stored* display string back to raw 24h "HH:MM". Handles both forms it might
// actually be in: "9:00 AM" (12h, written by time24hToDisplay below) and "14:00" (24h — either
// written directly somewhere, or read from an entry stored back when the device's locale
// defaulted toLocaleTimeString to 24h before this was made explicit). Falls back to noon only
// if the string genuinely doesn't parse as either.
export function timeDisplayTo24h(display) {
  const s = String(display || "").trim();
  const m12 = s.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = m12[2];
    const ap = m12[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${min}`;
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return `${m24[1].padStart(2, "0")}:${m24[2]}`;
  return "12:00";
}

// Writes the stored display string at log time — always 12h with AM/PM, regardless of the
// device's locale or the user's current display preference, so what's on disk is deterministic
// and always round-trips cleanly through timeDisplayTo24h. The user's 12h/24h *display*
// preference is applied separately, at render time, via formatStoredTime — never baked into
// storage, so flipping the toggle instantly reformats every entry, past and future alike.
export function time24hToDisplay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

// Reformats a stored display string according to the user's 12h/24h preference. This is the one
// place that actually branches on the setting — every other display helper (formatTimeRange)
// goes through this, so a single toggle reformats every already-logged entry immediately, not
// just new ones.
export function formatStoredTime(display, format = "12h") {
  const [h, m] = timeDisplayTo24h(display).split(":").map(Number);
  if (format === "24h") return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

// Minutes since midnight from a display-formatted time ("9:00 AM" -> 540), for sorting.
export function timeToMinutes(display) {
  const [h, m] = timeDisplayTo24h(display).split(":").map(Number);
  return h * 60 + m;
}

// A day's entries only ever land in the array in whatever order they were logged in — which
// isn't chronological once anything is backfilled to an earlier time than what's already there
// (see logFreeform's targetDayKey). Sorts by each entry's actual time instead, most recent
// first, matching the convention already used for the Timeline search results.
export function sortEntriesByTime(entries) {
  return [...entries].sort((a, b) => timeToMinutes(b.time) - timeToMinutes(a.time));
}

// "9:00 AM" + "10:30 AM" -> "9:00 AM – 10:30 AM" (or "09:00 – 10:30" in 24h mode); falls back to
// just the start time when there's no end time, so every call site can use this instead of
// branching itself. Reformats both through formatStoredTime, so this respects the current
// display preference regardless of what format the strings happen to be stored in.
export function formatTimeRange(time, endTime, format = "12h") {
  const t = formatStoredTime(time, format);
  return endTime ? `${t} – ${formatStoredTime(endTime, format)}` : t;
}

// Minutes between two display-formatted times ("9:00 AM", "10:30 AM"), e.g. "1h 30m". Assumes
// the end is the next occurrence of that clock time at or after the start — so an entry
// spanning midnight (e.g. 11 PM to 1 AM) still comes out positive instead of negative.
export function formatDuration(time, endTime) {
  if (!endTime) return "";
  const [sh, sm] = timeDisplayTo24h(time).split(":").map(Number);
  const [eh, em] = timeDisplayTo24h(endTime).split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
