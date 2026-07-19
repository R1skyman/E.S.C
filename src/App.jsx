import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Mail, Lock, Eye, EyeOff, HeartPulse, GraduationCap, Shield, Sparkles,
  ArrowRight, Check, Plus, Home, CalendarDays, Users, ChevronLeft,
  ChevronRight, Calendar, ChevronRight as ChevRight, X,
  MoreHorizontal, Settings as SettingsIcon, User, Bell, LogOut, HelpCircle, BookOpen, FolderKanban, ShieldCheck, RefreshCw, Phone, AlertTriangle, Activity, Search, MapPin, Pencil,
  Link as LinkIcon, WifiOff, Share2, Copy, BellRing, Palette, Volume2,
} from "lucide-react";
import { CATEGORY_META, DEFAULT_CATEGORY_COLORS, COLORBLIND_PALETTE, ROLE_META, DEFAULT_HOUSEHOLDS, URGENCY_RED_MS, URGENCY_YELLOW_MS } from "./constants.js";
import { getStatus, fmtCountdown, fmtElapsed } from "./utils/status.js";
import { dateKey, addDays, formatTimeForSpeech, nextOccurrence, formatEntryDate, timeDisplayTo24h, time24hToDisplay } from "./utils/dateHelpers.js";
import { uid, formatPhoneInput, buildHistorySummary, hoursToUnitDefault } from "./utils/misc.js";
import { supabase, getRememberMe, setRememberMe, getEmailRedirectTo } from "./utils/supabase.js";
import {
  fetchHouseholds, fetchChildData, fetchInfoBank, fetchOrCreateSettings, fetchActiveHouseholdId,
  createHousehold, updateHouseholdName, deleteHouseholdRow,
  updateMember, deleteMember, insertInvite, deleteInvite, acceptInviteRpc,
  insertChild, updateChild, deleteChildRow,
  replaceCareItems, replaceTimelineDay, replaceUpcomingItems, replaceInfoBank,
  saveSettingsRow, saveActiveHouseholdId,
} from "./utils/db.js";

// A stable (module-scope, so its array/object references never change identity across renders)
// stand-in for "no household exists yet" — keeps every screen that reads household.children /
// household.members safe without needing a null-check at each call site.
const EMPTY_HOUSEHOLD = { id: null, name: "", children: [], members: [], invites: [] };

// Supabase reports the outcome of an email confirmation / password recovery link as query or
// hash params on the redirect back to this app (e.g. a reused or expired signup confirmation
// link comes back as #error=access_denied&error_code=otp_expired&error_description=...). The
// SDK's own automatic URL handling (detectSessionInUrl) silently swallows this on failure —
// getSession() never surfaces it — so this reads the same params independently, straight off
// the URL, to actually show the user what went wrong instead of just dropping them on a blank
// login screen with no explanation.
function parseAuthCallbackError() {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const get = (key) => hash.get(key) || query.get(key);
  const error = get("error");
  if (!error) return null;
  return {
    code: get("error_code") || error,
    description: get("error_description")?.replace(/\+/g, " ") || "That link didn't work.",
  };
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------
export default function App() {
  const [viewportH, setViewportH] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 800));
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null); // real Supabase session; null = signed out
  const [authChecked, setAuthChecked] = useState(false); // has the initial getSession() resolved?
  const authed = !!session;
  // Captured once, synchronously, from the very first render — before anything else has a
  // chance to touch the URL — so a failed confirmation/recovery link is never missed.
  const [authCallbackError, setAuthCallbackError] = useState(parseAuthCallbackError);
  const [dbError, setDbError] = useState(null); // last failed read/write, shown as a dismissible banner
  const [tab, setTab] = useState("today");
  const [childId, setChildId] = useState("");
  const [households, setHouseholds] = useState(DEFAULT_HOUSEHOLDS);
  const [activeHouseholdId, setActiveHouseholdId] = useState(DEFAULT_HOUSEHOLDS[0]?.id ?? null);
  const household = households.find((h) => h.id === activeHouseholdId) || households[0] || EMPTY_HOUSEHOLD;
  const [infoBank, setInfoBank] = useState({}); // keyed by household id, same pattern as careItems/timeline
  const [careItems, setCareItems] = useState({});
  const [timeline, setTimeline] = useState({});
  const [upcoming, setUpcoming] = useState({}); // keyed by childId — one-time future-dated items (appointments, etc.)
  const [now, setNow] = useState(Date.now());
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [timelineOffset, setTimelineOffset] = useState(0); // which day Timeline is currently showing, relative to today
  const [settings, setSettings] = useState({
    notifyMeds: true, notifyEvents: true, notifyChannel: "email",
    profile: { firstName: "", lastName: "", email: "", phone: "" },
    categoryColors: {}, // per-category color overrides, keyed by category — empty means "use defaults"
    readAloud: false, // tap-to-hear accessibility mode
  });
  const myRole = household.members.find((m) => m.isYou)?.role || "owner";

  // Apply any per-category color overrides from settings. CATEGORY_META is read fresh (not cached)
  // by every screen that shows a category icon, so mutating it here — synchronously, every render —
  // means a color change in Settings shows up everywhere immediately, with no prop-threading needed.
  for (const key of Object.keys(CATEGORY_META)) {
    CATEGORY_META[key].color = settings.categoryColors?.[key] || DEFAULT_CATEGORY_COLORS[key];
  }
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const notifiedRef = useRef(new Set()); // tracks which item+cycle we've already alerted on, so we don't spam

  const requestNotifications = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  }, []);

  // Real browser notifications — these only fire while this tab/app is open (foreground or
  // backgrounded), since a true background push would need a server and a service worker,
  // which a browser artifact like this doesn't have. Still genuinely useful: leave the app
  // open on a device nearby and you'll get an actual system notification, not just a
  // countdown you have to remember to check.
  useEffect(() => {
    if (notifPermission !== "granted") return;
    for (const [cid, items] of Object.entries(careItems)) {
      for (const item of items) {
        const status = getStatus(item, now);
        const settingOn = item.category === "medication" ? settings.notifyMeds : settings.notifyEvents;
        if (!settingOn) continue;
        const cycleKey = `${item.id}:${item.lastDone}`;
        const childName = household.children.find((c) => c.id === cid)?.name || "your child";

        if (status.stage === "yellow" && !notifiedRef.current.has(`${cycleKey}:yellow`)) {
          notifiedRef.current.add(`${cycleKey}:yellow`);
          try {
            new Notification(`${item.title} — getting close`, {
              body: `${childName} — ${fmtCountdown(status.remaining)} left.`,
            });
          } catch { /* fail silently */ }
        }
        if (status.stage === "red" && !notifiedRef.current.has(`${cycleKey}:red`)) {
          notifiedRef.current.add(`${cycleKey}:red`);
          try {
            new Notification(`${item.title} — almost due`, {
              body: `${childName} — ${fmtCountdown(status.remaining)} left.`,
            });
          } catch { /* fail silently */ }
        }
        if (status.ready && !notifiedRef.current.has(`${cycleKey}:ready`)) {
          notifiedRef.current.add(`${cycleKey}:ready`);
          try {
            new Notification(`${item.title} is ready`, {
              body: `${childName} — ${item.timingModel === "scheduled" ? "next dose is due now" : "available again now"}.`,
            });
          } catch { /* Notification constructor can throw in some contexts — fail silently */ }
        }
      }
    }
    // Upcoming (one-time, future-dated) events — same yellow/red/arrived transitions as care items.
    if (!settings.notifyEvents) return;
    for (const [cid, items] of Object.entries(upcoming)) {
      for (const item of items) {
        const diff = item.timestamp - now;
        const childName = household.children.find((c) => c.id === cid)?.name || "your child";

        if (diff > 0 && diff <= URGENCY_YELLOW_MS && !notifiedRef.current.has(`upcoming:${item.id}:${item.timestamp}:yellow`)) {
          notifiedRef.current.add(`upcoming:${item.id}:${item.timestamp}:yellow`);
          try {
            new Notification(`${item.title} — getting close`, { body: `${childName} — ${fmtCountdown(diff)} away.` });
          } catch { /* fail silently */ }
        }
        if (diff > 0 && diff <= URGENCY_RED_MS && !notifiedRef.current.has(`upcoming:${item.id}:${item.timestamp}:red`)) {
          notifiedRef.current.add(`upcoming:${item.id}:${item.timestamp}:red`);
          try {
            new Notification(`${item.title} — almost time`, { body: `${childName} — ${fmtCountdown(diff)} away.` });
          } catch { /* fail silently */ }
        }
        if (diff <= 0 && !notifiedRef.current.has(`upcoming:${item.id}:${item.timestamp}:arrived`)) {
          notifiedRef.current.add(`upcoming:${item.id}:${item.timestamp}:arrived`);
          try {
            new Notification(item.title, { body: `${childName}${item.subtitle ? ` — ${item.subtitle}` : ""}` });
          } catch { /* fail silently */ }
        }
      }
    }
  }, [now, careItems, upcoming, notifPermission, settings.notifyMeds, settings.notifyEvents, household.children]);

  // Read Aloud — an accessibility mode for people who benefit from hearing text as well as
  // seeing it (low vision, reading difficulties, etc.). This listens for the SAME clicks that
  // already trigger every button and link in the app, but never calls preventDefault or
  // stopPropagation — so it can only ever ADD a spoken echo of what was tapped, never change
  // or block what tapping it actually does.
  const [readAloudRect, setReadAloudRect] = useState(null);
  const readAloudTimeoutRef = useRef(null);

  // A standalone announce function, usable anywhere Read Aloud needs to speak something that
  // didn't come from a plain click — e.g. announcing which date got picked from a native date
  // picker, whose own popup is entirely outside our page and can never be tapped into directly.
  const speakText = useCallback((text) => {
    if (!settings.readAloud || !text) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch { /* speech synthesis unavailable in this browser */ }
  }, [settings.readAloud]);

  useEffect(() => {
    if (!settings.readAloud) return;
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const findSpeakableText = (el) => {
      let node = el;
      let depth = 0;
      while (node && depth < 4) {
        const text = (node.innerText || node.textContent || "").trim();
        if (text) return text.slice(0, 300); // cap length so a long paragraph doesn't read for a full minute
        node = node.parentElement;
        depth++;
      }
      return "";
    };

    const onClick = (e) => {
      // Native form controls — date/time/color inputs, selects, text fields — have their own
      // built-in interaction UI (like a date picker popup) that isn't ours to narrate, and doing
      // anything extra on the same click risks disrupting it. Leave these completely untouched;
      // components that need to announce a result from one of these use speakText directly instead,
      // triggered by onChange once the native interaction has already finished.
      if (e.target.closest("input, select, textarea")) return;

      const text = findSpeakableText(e.target);
      if (!text) return; // icon-only buttons etc. — nothing to say, and the tap itself is untouched either way
      speakText(text);

      const rect = e.target.getBoundingClientRect();
      setReadAloudRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
      clearTimeout(readAloudTimeoutRef.current);
      readAloudTimeoutRef.current = setTimeout(() => setReadAloudRect(null), 1100);
    };

    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      window.speechSynthesis?.cancel();
      clearTimeout(readAloudTimeoutRef.current);
      setReadAloudRect(null);
    };
  }, [settings.readAloud, speakText]);


  // Basic connectivity awareness — this app depends on network calls for every read/write,
  // so if you lose signal, actions will silently fail without this. It's not true offline
  // support (nothing is cached or queued to sync later), just an honest heads-up.
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    const update = () => setViewportH(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Loads everything fresh from storage — this is exactly what happens on a real cold start
  // (app force-quit and reopened). Reusable so a "simulate reopening" action can trigger the
  // same path without actually reloading the artifact.
  const defaultSettingsShape = {
    notifyMeds: true, notifyEvents: true, notifyChannel: "email",
    profile: { firstName: "", lastName: "", email: "", phone: "" },
  };

  // Loads everything from Supabase for the given (already-authenticated) session — this is
  // exactly what happens on a real cold start, and also what "simulate reopening" re-runs.
  const bootstrap = useCallback(async (sess) => {
    setLoading(true);
    try {
      const userId = sess.user.id;
      const st = await fetchOrCreateSettings(userId, defaultSettingsShape);
      setSettings(st);

      const hhList = await fetchHouseholds(userId);
      const storedActiveId = await fetchActiveHouseholdId(userId);
      const activeId = hhList.find((h) => h.id === storedActiveId)?.id || hhList[0]?.id || null;
      setHouseholds(hhList);
      setActiveHouseholdId(activeId);

      const activeHH = hhList.find((h) => h.id === activeId) || null;
      if (activeHH) {
        const { careItems, timeline, upcoming } = await fetchChildData(activeHH.children.map((c) => c.id));
        setCareItems(careItems);
        setTimeline(timeline);
        setUpcoming(upcoming);
        setInfoBank({ [activeId]: await fetchInfoBank(activeId) });
        setChildId(activeHH.children[0]?.id || "");
      } else {
        setCareItems({});
        setTimeline({});
        setUpcoming({});
        setInfoBank({});
        setChildId("");
      }
      setTab("today");
    } catch (e) {
      console.error("bootstrap failed", e);
      setDbError(e.message || "Couldn't load your data. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Scrub error/token params out of the address bar once captured, so a refresh doesn't
  // re-show a stale error and a successful callback doesn't leave tokens sitting in the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.hash && !window.location.search) return;
    const url = new URL(window.location.href);
    url.hash = "";
    for (const key of ["error", "error_code", "error_description", "code", "type"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real auth lifecycle: getSession() resolves the persisted session (if any) once on mount,
  // then onAuthStateChange keeps `session` in sync with every sign-in/sign-out/token refresh.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  // Load (or clear) app data whenever the session actually changes, not on every render.
  useEffect(() => {
    if (session) {
      bootstrap(session);
    } else if (authChecked) {
      setHouseholds(DEFAULT_HOUSEHOLDS);
      setActiveHouseholdId(null);
      setCareItems({});
      setTimeline({});
      setUpcoming({});
      setInfoBank({});
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, authChecked]);

  // Diffs the given household against current state and applies exactly the rows that
  // changed, rather than blindly rewriting everything: unlike the old single-blob
  // localStorage write, each of these is now a real normalized table, and re-inserting
  // a child wholesale would cascade-delete its care items before the reinsert ever
  // happened. Most existing call sites build a full updated household object and call
  // this — that doesn't change.
  const persistHousehold = useCallback(async (next) => {
    const prev = households.find((h) => h.id === next.id);
    if (!prev) return;
    try {
      if (next.name !== prev.name) await updateHouseholdName(next.id, next.name);

      const prevChildren = new Map(prev.children.map((c) => [c.id, c]));
      const nextChildIds = new Set(next.children.map((c) => c.id));
      for (const c of next.children) {
        const before = prevChildren.get(c.id);
        if (!before) await insertChild(next.id, c);
        else if (before.name !== c.name || before.initials !== c.initials || before.age !== c.age || before.bio !== c.bio) {
          await updateChild(c.id, c);
        }
      }
      for (const c of prev.children) {
        if (!nextChildIds.has(c.id)) await deleteChildRow(c.id);
      }

      const prevMembers = new Map(prev.members.map((m) => [m.id, m]));
      const nextMemberIds = new Set(next.members.map((m) => m.id));
      for (const m of next.members) {
        const before = prevMembers.get(m.id);
        if (before && (before.role !== m.role || before.note !== m.note)) await updateMember(m.id, m);
      }
      for (const m of prev.members) {
        if (!nextMemberIds.has(m.id)) await deleteMember(m.id);
      }

      const prevInviteIds = new Set(prev.invites.map((i) => i.id));
      const nextInviteIds = new Set(next.invites.map((i) => i.id));
      for (const i of next.invites) {
        if (!prevInviteIds.has(i.id)) await insertInvite(next.id, i);
      }
      for (const i of prev.invites) {
        if (!nextInviteIds.has(i.id)) await deleteInvite(i.id);
      }

      setHouseholds((curr) => curr.map((h) => (h.id === next.id ? next : h)));
    } catch (e) {
      console.error("persistHousehold failed", e);
      setDbError(e.message || "Couldn't save that change. Please try again.");
    }
  }, [households]);

  const persistCare = useCallback(async (cid, next) => {
    try {
      await replaceCareItems(cid, next);
      setCareItems((prev) => ({ ...prev, [cid]: next }));
    } catch (e) {
      console.error("persistCare failed", e);
      setDbError(e.message || "Couldn't save that change. Please try again.");
    }
  }, []);

  const persistTimeline = useCallback(async (cid, next) => {
    try {
      // Every call site only ever touches one day at a time (spreads the rest through
      // unchanged), but diff anyway rather than assume — cheap, and correct if that
      // ever stops being true.
      const prevTl = timeline[cid] || {};
      const changedDays = new Set([...Object.keys(prevTl), ...Object.keys(next)].filter((day) => prevTl[day] !== next[day]));
      for (const day of changedDays) {
        await replaceTimelineDay(cid, day, next[day] || []);
      }
      setTimeline((prev) => ({ ...prev, [cid]: next }));
    } catch (e) {
      console.error("persistTimeline failed", e);
      setDbError(e.message || "Couldn't save that change. Please try again.");
    }
  }, [timeline]);

  const persistUpcoming = useCallback(async (cid, next) => {
    try {
      await replaceUpcomingItems(cid, next);
      setUpcoming((prev) => ({ ...prev, [cid]: next }));
    } catch (e) {
      console.error("persistUpcoming failed", e);
      setDbError(e.message || "Couldn't save that change. Please try again.");
    }
  }, []);

  // Recurring scheduled events: once one's time passes, log that occurrence into the
  // Timeline (so the history isn't just silently lost) and roll it forward to its next
  // occurrence automatically, so a weekly appointment doesn't have to be rescheduled by hand.
  useEffect(() => {
    for (const [cid, items] of Object.entries(upcoming)) {
      const passed = items.filter((it) => it.recurrence && it.recurrence !== "none" && it.timestamp <= now);
      if (passed.length === 0) continue;
      let tl = timeline[cid] || {};
      const nextItems = items.map((it) => {
        if (!it.recurrence || it.recurrence === "none" || it.timestamp > now) return it;
        const occurredDate = dateKey(new Date(it.timestamp));
        const dayEntries = tl[occurredDate] || [];
        const entry = {
          id: uid(),
          time: new Date(it.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
          date: occurredDate, category: it.category, title: it.title, subtitle: it.subtitle,
          loggedBy: "Recurring schedule",
        };
        tl = { ...tl, [occurredDate]: [...dayEntries, entry] };
        return { ...it, timestamp: nextOccurrence(it.timestamp, it.recurrence, now) };
      });
      persistUpcoming(cid, nextItems);
      persistTimeline(cid, tl);
    }
  }, [now, upcoming, timeline, persistUpcoming, persistTimeline]);

  const switchHousehold = useCallback(async (id) => {
    setActiveHouseholdId(id);
    if (session) saveActiveHouseholdId(session.user.id, id).catch((e) => console.error("saveActiveHouseholdId failed", e));
    const hh = households.find((h) => h.id === id);
    if (!hh) return;
    setChildId(hh.children[0]?.id || "");
    try {
      // lazy-load care/timeline/upcoming for any of this household's children not already in memory
      const missingChildIds = hh.children.filter((c) => !(c.id in careItems)).map((c) => c.id);
      if (missingChildIds.length) {
        const { careItems: newCare, timeline: newTl, upcoming: newUp } = await fetchChildData(missingChildIds);
        setCareItems((prev) => ({ ...prev, ...newCare }));
        setTimeline((prev) => ({ ...prev, ...newTl }));
        setUpcoming((prev) => ({ ...prev, ...newUp }));
      }
      // lazy-load this household's Info Bank if we haven't seen it yet
      if (!(id in infoBank)) {
        const ib = await fetchInfoBank(id);
        setInfoBank((prev) => ({ ...prev, [id]: ib }));
      }
    } catch (e) {
      console.error("switchHousehold failed", e);
      setDbError(e.message || "Couldn't load that household. Please try again.");
    }
  }, [households, careItems, infoBank, session]);

  const addHousehold = useCallback(async (name) => {
    try {
      const displayName = [settings.profile.firstName, settings.profile.lastName].filter(Boolean).join(" ").trim()
        || session?.user?.user_metadata?.full_name || "You";
      const initials = displayName.trim()[0]?.toUpperCase() || "Y";
      const newHH = await createHousehold(name.trim() || "New Household", displayName, initials, session.user.id);
      setHouseholds((prev) => [...prev, newHH]);
      await switchHousehold(newHH.id);
    } catch (e) {
      console.error("addHousehold failed", e);
      setDbError(e.message || "Couldn't create the household. Please try again.");
    }
  }, [settings, session, switchHousehold]);

  const deleteHousehold = useCallback(async (householdIdToDelete) => {
    if (households.length <= 1) return; // never leave the app with zero households
    const hh = households.find((h) => h.id === householdIdToDelete);
    if (!hh) return;
    try {
      // Cascades in the database: members, invites, children, each child's care items,
      // timeline entries, and upcoming items, plus this household's Info Bank contacts.
      await deleteHouseholdRow(householdIdToDelete);
      const nextHouseholds = households.filter((h) => h.id !== householdIdToDelete);
      setCareItems((prev) => { const next = { ...prev }; hh.children.forEach((c) => delete next[c.id]); return next; });
      setTimeline((prev) => { const next = { ...prev }; hh.children.forEach((c) => delete next[c.id]); return next; });
      setUpcoming((prev) => { const next = { ...prev }; hh.children.forEach((c) => delete next[c.id]); return next; });
      setInfoBank((prev) => { const next = { ...prev }; delete next[householdIdToDelete]; return next; });
      setHouseholds(nextHouseholds);
      if (activeHouseholdId === householdIdToDelete) {
        await switchHousehold(nextHouseholds[0].id);
      }
    } catch (e) {
      console.error("deleteHousehold failed", e);
      setDbError(e.message || "Couldn't delete that household. Please try again.");
    }
  }, [households, activeHouseholdId, switchHousehold]);

  const addChild = useCallback(async (name, age) => {
    const id = uid();
    const newChild = { id, name: name.trim(), initials: name.trim()[0]?.toUpperCase() || "?", age: Number(age) || 0 };
    const nextHousehold = { ...household, children: [...household.children, newChild] };
    await persistHousehold(nextHousehold);
    await persistCare(id, []);
    await persistTimeline(id, {});
    await persistUpcoming(id, []);
    setChildId(id);
  }, [household, persistHousehold, persistCare, persistTimeline, persistUpcoming]);

  const editChild = useCallback(async (childIdToEdit, { name, age, bio }) => {
    const nextHousehold = {
      ...household,
      children: household.children.map((c) => (c.id === childIdToEdit
        ? { ...c, name: name.trim(), initials: name.trim()[0]?.toUpperCase() || "?", age: Number(age) || 0, bio: (bio || "").trim() }
        : c)),
    };
    await persistHousehold(nextHousehold);
  }, [household, persistHousehold]);

  const deleteChild = useCallback(async (childIdToDelete) => {
    const nextChildren = household.children.filter((c) => c.id !== childIdToDelete);
    const nextHousehold = { ...household, children: nextChildren };
    await persistHousehold(nextHousehold); // cascades: deletes this child's care items, timeline entries, and upcoming items too
    setCareItems((prev) => { const next = { ...prev }; delete next[childIdToDelete]; return next; });
    setTimeline((prev) => { const next = { ...prev }; delete next[childIdToDelete]; return next; });
    setUpcoming((prev) => { const next = { ...prev }; delete next[childIdToDelete]; return next; });
    if (childId === childIdToDelete) setChildId(nextChildren[0]?.id || "");
  }, [household, persistHousehold, childId]);

  // Schedule a one-time future event — genuinely different from logging a recurring care
  // item: this has a real future date/time, its own countdown, and its own notification,
  // rather than pretending "log it now" can mean "remind me later."
  const scheduleUpcoming = useCallback(async (cid, { category, title, subtitle, notes, timestamp, recurrence }) => {
    const items = upcoming[cid] || [];
    const newItem = { id: uid(), category, title, subtitle: subtitle || "", notes: notes || "", timestamp, recurrence: recurrence || "none", notified: false };
    await persistUpcoming(cid, [...items, newItem]);
  }, [upcoming, persistUpcoming]);

  // Creates a new recurring "quick tap" item directly, without requiring you to also log
  // an entry for right now — for setting up a schedule in advance rather than only ever
  // being able to add a preset as a side effect of logging something that just happened.
  // It starts already "available" (marked as if the gap has already passed), since you
  // haven't actually given/done it yet through this app.
  const createPreset = useCallback(async (cid, { category, title, subtitle, timingModel, intervalHours, minGapHours }) => {
    const items = careItems[cid] || [];
    const gapValue = timingModel === "scheduled" ? Number(intervalHours) : Number(minGapHours);
    if (!(gapValue > 0)) return;
    const newItem = {
      id: uid(), category, title, subtitle: subtitle || "", timingModel,
      lastDone: Date.now() - gapValue * 3600 * 1000 - 1000, // starts ready, since it hasn't actually been given yet
      ...(timingModel === "scheduled" ? { intervalHours: gapValue } : { minGapHours: gapValue }),
    };
    await persistCare(cid, [...items, newItem]);
  }, [careItems, persistCare]);

  // Edit an existing quick-tap preset — e.g., a dosage changed, or the interval needs updating.
  // Note: intentionally does NOT touch lastDone, so editing the schedule doesn't reset the
  // live countdown as a side effect.
  const editCareItem = useCallback(async (cid, id, patch) => {
    const items = careItems[cid] || [];
    await persistCare(cid, items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, [careItems, persistCare]);

  const deleteCareItem = useCallback(async (cid, id) => {
    const items = careItems[cid] || [];
    await persistCare(cid, items.filter((i) => i.id !== id));
  }, [careItems, persistCare]);

  const editUpcoming = useCallback(async (cid, id, patch) => {
    const items = upcoming[cid] || [];
    await persistUpcoming(cid, items.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, [upcoming, persistUpcoming]);

  const deleteUpcoming = useCallback(async (cid, id) => {
    const items = upcoming[cid] || [];
    await persistUpcoming(cid, items.filter((u) => u.id !== id));
  }, [upcoming, persistUpcoming]);

  // Logging a care item: reset its timer AND append a timeline entry for today
  const logCareItem = useCallback(async (cid, itemId, targetDayKey) => {
    const items = careItems[cid] || [];
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const nextItems = items.map((i) => (i.id === itemId ? { ...i, lastDone: Date.now() } : i));
    await persistCare(cid, nextItems);

    const day = targetDayKey || dateKey(new Date());
    const tl = timeline[cid] || {};
    const dayEntries = tl[day] || [];
    const entry = {
      id: uid(),
      time: new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
      date: day,
      category: item.category,
      title: item.title,
      subtitle: item.subtitle,
      loggedBy: household.members.find((m) => m.isYou)?.name || "You",
    };
    const nextTl = { ...tl, [day]: [...dayEntries, entry] };
    await persistTimeline(cid, nextTl);
  }, [careItems, timeline, persistCare, persistTimeline, household]);

  // Freeform log: any category/title/subtitle/time, not tied to an existing preset item.
  // targetDayKey lets this log to whatever day is actually being viewed (e.g. backfilling a
  // past day from the Timeline), not just today. If trackGoing is set, it also creates a new
  // recurring care item — only meaningful for today, since it resets a live countdown from now.
  const logFreeform = useCallback(async (cid, { category, title, subtitle, time, timestamp, trackGoing, timingModel, intervalHours, minGapHours }, targetDayKey) => {
    const day = targetDayKey || dateKey(new Date());
    const tl = timeline[cid] || {};
    const dayEntries = tl[day] || [];
    const entry = { id: uid(), time, date: day, category, title, subtitle, loggedBy: household.members.find((m) => m.isYou)?.name || "You" };
    const nextTl = { ...tl, [day]: [...dayEntries, entry] };
    await persistTimeline(cid, nextTl);

    if (trackGoing) {
      const items = careItems[cid] || [];
      const gapValue = timingModel === "scheduled" ? Number(intervalHours) : Number(minGapHours);
      if (!(gapValue > 0)) return; // never silently guess a timing value
      const newItem = {
        id: uid(), category, title, subtitle, timingModel,
        lastDone: timestamp || Date.now(), // the actual time it happened, not the moment it was saved
        ...(timingModel === "scheduled" ? { intervalHours: gapValue } : { minGapHours: gapValue }),
      };
      await persistCare(cid, [...items, newItem]);
    }
  }, [careItems, timeline, persistCare, persistTimeline, household]);

  // Edit or delete a specific timeline entry, identified by which day (dayKey) it lives under.
  const editTimelineEntry = useCallback(async (cid, dayKey, entryId, patch) => {
    const tl = timeline[cid] || {};
    const dayEntries = tl[dayKey] || [];
    const nextDay = dayEntries.map((e) => (e.id === entryId ? { ...e, ...patch } : e));
    await persistTimeline(cid, { ...tl, [dayKey]: nextDay });
  }, [timeline, persistTimeline]);

  const deleteTimelineEntry = useCallback(async (cid, dayKey, entryId) => {
    const tl = timeline[cid] || {};
    const dayEntries = tl[dayKey] || [];
    const nextDay = dayEntries.filter((e) => e.id !== entryId);
    await persistTimeline(cid, { ...tl, [dayKey]: nextDay });
  }, [timeline, persistTimeline]);

  const persistSettings = useCallback(async (next) => {
    try {
      await saveSettingsRow(session.user.id, next);
      setSettings(next);
    } catch (e) {
      console.error("persistSettings failed", e);
      setDbError(e.message || "Couldn't save that change. Please try again.");
    }
  }, [session]);

  const persistInfoBank = useCallback(async (next) => {
    try {
      await replaceInfoBank(activeHouseholdId, next);
      setInfoBank((prev) => ({ ...prev, [activeHouseholdId]: next }));
    } catch (e) {
      console.error("persistInfoBank failed", e);
      setDbError(e.message || "Couldn't save that change. Please try again.");
    }
  }, [activeHouseholdId]);

  const logout = useCallback(async () => {
    await supabase.auth.signOut(); // session -> null flows through onAuthStateChange, which resets app state
    setTab("today");
  }, []);

  const deleteAllData = useCallback(async () => {
    try {
      for (const h of households) {
        try { await deleteHouseholdRow(h.id); } catch (e) { console.error(`delete household ${h.id} failed`, e); }
      }
      if (session) {
        try { await supabase.from("user_settings").delete().eq("user_id", session.user.id); } catch (e) { console.error("delete user_settings failed", e); }
      }
      await supabase.auth.signOut();
      setHouseholds(DEFAULT_HOUSEHOLDS);
      setActiveHouseholdId(null);
      setCareItems({});
      setTimeline({});
      setUpcoming({});
      setInfoBank({});
      setSettings({ notifyMeds: true, notifyEvents: true, notifyChannel: "email", profile: { firstName: "", lastName: "", email: "", phone: "" } });
      setTab("today");
    } catch (e) {
      console.error("deleteAllData failed", e);
      setDbError(e.message || "Couldn't delete your data. Please try again.");
    }
  }, [households, session]);

  if (loading) {
    return (
      <div className="flex justify-center items-center" style={{ minHeight: viewportH, backgroundColor: "#F7F9FB" }}>
        <p className="text-[13px] text-[#8A94A0]">Loading…</p>
      </div>
    );
  }

  if (authCallbackError) {
    return <AuthCallbackErrorScreen viewportH={viewportH} error={authCallbackError} onDismiss={() => setAuthCallbackError(null)} />;
  }

  if (!authed) {
    return <LoginScreen viewportH={viewportH} />;
  }

  if (households.length === 0) {
    return <CreateHouseholdScreen viewportH={viewportH} onCreate={addHousehold} onLogout={logout} dbError={dbError} onDismissError={() => setDbError(null)} />;
  }

  return (
    <div className="flex justify-center" style={{ fontFamily: "-apple-system, sans-serif", minHeight: viewportH, backgroundColor: "#F7F9FB" }}>
      <div className="w-full max-w-[420px] relative overflow-hidden flex flex-col" style={{ height: viewportH, backgroundColor: "#F7F9FB" }}>
        {readAloudRect && (
          <div
            style={{
              position: "fixed", top: readAloudRect.top - 3, left: readAloudRect.left - 3,
              width: readAloudRect.width + 6, height: readAloudRect.height + 6,
              backgroundColor: "rgba(201,154,78,0.22)", border: "2px solid #C99A4E", borderRadius: 8,
              pointerEvents: "none", zIndex: 200, transition: "opacity 250ms ease",
            }}
          />
        )}
        {!isOnline && (
          <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ backgroundColor: "#C67B6C" }}>
            <WifiOff size={14} color="white" />
            <span className="text-[12px] font-semibold text-white">
              You're offline — changes won't save until you're back online.
            </span>
          </div>
        )}
        {dbError && (
          <button onClick={() => setDbError(null)} className="flex items-center gap-2 px-4 py-2 shrink-0 text-left" style={{ backgroundColor: "#C67B6C", WebkitAppearance: "none" }}>
            <AlertTriangle size={14} color="white" className="shrink-0" />
            <span className="text-[12px] font-semibold text-white flex-1">{dbError}</span>
            <X size={14} color="white" className="shrink-0" />
          </button>
        )}
        <div className="flex-1 overflow-y-auto overflow-x-hidden pb-24">
          {tab === "today" && (
            <TodayScreen
              household={household} childId={childId} setChildId={setChildId}
              careItems={careItems[childId] || []} timeline={timeline[childId] || {}}
              upcoming={upcoming[childId] || []} speakText={speakText}
              now={now} onOpenQuickLog={() => setQuickLogOpen(true)} myRole={myRole}
              onEditEntry={(dayKey, entryId, patch) => editTimelineEntry(childId, dayKey, entryId, patch)}
              onDeleteEntry={(dayKey, entryId) => deleteTimelineEntry(childId, dayKey, entryId)}
              onEditUpcoming={(id, patch) => editUpcoming(childId, id, patch)}
              onDeleteUpcoming={(id) => deleteUpcoming(childId, id)}
              onLogPreset={(itemId) => logCareItem(childId, itemId)}
              onEditPreset={(id, patch) => editCareItem(childId, id, patch)}
              onDeletePreset={(id) => deleteCareItem(childId, id)}
            />
          )}
          {tab === "timeline" && (
            <TimelineScreen
              household={household} childId={childId} setChildId={setChildId}
              careItems={careItems[childId] || []} timeline={timeline[childId] || {}}
              now={now} myRole={myRole} speakText={speakText}
              centerOffset={timelineOffset} setCenterOffset={setTimelineOffset}
              onEditEntry={(dayKey, entryId, patch) => editTimelineEntry(childId, dayKey, entryId, patch)}
              onDeleteEntry={(dayKey, entryId) => deleteTimelineEntry(childId, dayKey, entryId)}
            />
          )}
          {tab === "household" && (
            <HouseholdScreen household={household} persistHousehold={persistHousehold} addChild={addChild} editChild={editChild} deleteChild={deleteChild} myRole={myRole}
              households={households} activeHouseholdId={activeHouseholdId} switchHousehold={switchHousehold} addHousehold={addHousehold} deleteHousehold={deleteHousehold} />
          )}
          {tab === "settings" && (
            <SettingsScreen settings={settings} persistSettings={persistSettings} onLogout={logout} onDeleteAllData={deleteAllData} onSimulateReopen={() => bootstrap(session)}
              household={household} persistHousehold={persistHousehold} myRole={myRole} infoBank={infoBank[activeHouseholdId] || []} persistInfoBank={persistInfoBank}
              households={households} activeHouseholdId={activeHouseholdId} switchHousehold={switchHousehold}
              notifPermission={notifPermission} requestNotifications={requestNotifications} speakText={speakText} />
          )}
        </div>

        {myRole !== "view" && (tab === "today" || tab === "timeline") && household.children.length > 0 && (
          <button
            onClick={() => setQuickLogOpen(true)}
            className="absolute bottom-24 right-6 w-14 h-14 rounded-full shadow-lg flex items-center justify-center active:scale-95 transition-transform"
            style={{ backgroundColor: "#4A7FAE" }} aria-label="Quick log"
          >
            <Plus size={26} color="white" />
          </button>
        )}

        <div className="absolute bottom-0 left-0 right-0 px-4 py-2.5 flex justify-between" style={{ backgroundColor: "white", borderTop: "1px solid #DCEAF5" }}>
          <button onClick={() => setTab("today")} className="flex flex-col items-center gap-1" style={{ backgroundColor: "transparent", color: tab === "today" ? "#4A7FAE" : "#A9B3BD", WebkitAppearance: "none", padding: 0, margin: 0 }}>
            <Home size={21} /><span className="text-[11.5px] leading-none" style={{ fontWeight: tab === "today" ? 600 : 500 }}>Today</span>
          </button>
          <button onClick={() => setTab("timeline")} className="flex flex-col items-center gap-1" style={{ backgroundColor: "transparent", color: tab === "timeline" ? "#4A7FAE" : "#A9B3BD", WebkitAppearance: "none", padding: 0, margin: 0 }}>
            <CalendarDays size={21} /><span className="text-[11.5px] leading-none" style={{ fontWeight: tab === "timeline" ? 600 : 500 }}>Timeline</span>
          </button>
          <button onClick={() => setTab("household")} className="flex flex-col items-center gap-1" style={{ backgroundColor: "transparent", color: tab === "household" ? "#4A7FAE" : "#A9B3BD", WebkitAppearance: "none", padding: 0, margin: 0 }}>
            <Users size={21} /><span className="text-[11.5px] leading-none" style={{ fontWeight: tab === "household" ? 600 : 500 }}>Household</span>
          </button>
          <button onClick={() => setTab("settings")} className="flex flex-col items-center gap-1" style={{ backgroundColor: "transparent", color: tab === "settings" ? "#4A7FAE" : "#A9B3BD", WebkitAppearance: "none", padding: 0, margin: 0 }}>
            <MoreHorizontal size={21} /><span className="text-[11.5px] leading-none" style={{ fontWeight: tab === "settings" ? 600 : 500 }}>More</span>
          </button>
        </div>

        {quickLogOpen && (
          <QuickLogModal
            kids={household.children} activeChildId={childId} speakText={speakText}
            items={careItems[childId] || []} now={now} myRole={myRole}
            targetDayKey={tab === "timeline" ? dateKey(addDays(new Date(), timelineOffset)) : dateKey(new Date())}
            onLog={async (itemId) => { await logCareItem(childId, itemId, tab === "timeline" ? dateKey(addDays(new Date(), timelineOffset)) : undefined); setQuickLogOpen(false); }}
            onAddFreeform={async (kidIds, data) => {
              const day = tab === "timeline" ? dateKey(addDays(new Date(), timelineOffset)) : undefined;
              await Promise.all(kidIds.map((kid) => logFreeform(kid, data, day)));
              setQuickLogOpen(false);
            }}
            onSchedule={async (kidIds, data) => { await Promise.all(kidIds.map((kid) => scheduleUpcoming(kid, data))); }}
            onCreatePreset={async (kidIds, data) => { await Promise.all(kidIds.map((kid) => createPreset(kid, data))); }}
            onEditPreset={async (id, patch) => { await editCareItem(childId, id, patch); }}
            onDeletePreset={async (id) => { await deleteCareItem(childId, id); }}
            onClose={() => setQuickLogOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth callback error — shown when a signup confirmation or password-recovery link comes
// back with an error (expired, already used, or otherwise rejected) instead of a session.
// Supabase's own automatic handling of these links (detectSessionInUrl) swallows failures
// silently — there's no event or return value that surfaces them — so App reads the error
// straight off the URL itself (see parseAuthCallbackError) and this screen shows it plainly,
// with a way to get a fresh link on the spot instead of a dead end.
// ---------------------------------------------------------------------------
function AuthCallbackErrorScreen({ viewportH, error, onDismiss }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState(null); // null | "sending" | "sent" | <error message>

  const resend = async () => {
    const trimmed = email.trim();
    if (trimmed.length <= 3 || status === "sending") return;
    setStatus("sending");
    const { error: resendError } = await supabase.auth.resend({
      type: "signup", email: trimmed, options: { emailRedirectTo: getEmailRedirectTo() },
    });
    setStatus(resendError ? resendError.message : "sent");
  };

  const canResend = email.trim().length > 3 && status !== "sending";

  return (
    <div className="flex justify-center" style={{ fontFamily: "-apple-system, sans-serif", minHeight: viewportH, backgroundColor: "#F7F9FB" }}>
      <div className="w-full max-w-[420px] relative overflow-hidden flex flex-col" style={{ height: viewportH, backgroundColor: "#F7F9FB" }}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 flex flex-col justify-center">
          <div className="mb-6 text-center">
            <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: "rgba(198,123,108,0.12)" }}>
              <AlertTriangle size={24} color="#C67B6C" />
            </div>
            <h1 className="font-display text-[22px] text-[#3A4048] mb-2">That link didn't work</h1>
            <p className="text-[13px] text-[#8A94A0] leading-relaxed">
              {error.description}{/\.\s*$/.test(error.description) ? "" : "."}
              {(error.code === "otp_expired" || error.code === "access_denied") && (
                <> Confirmation links expire after a while and only work once — if you clicked it twice, or your email app opened it automatically, this is why.</>
              )}
            </p>
          </div>

          {status !== "sent" ? (
            <div className="flex flex-col gap-3">
              <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                <Mail size={17} color="#8A94A0" />
                <input type="email" placeholder="Your email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
              </label>
              {status && status !== "sending" && <p className="text-[12px] font-medium text-[#C67B6C] px-0.5">{status}</p>}
              <button onClick={resend} disabled={!canResend} className="rounded-2xl py-3.5 font-semibold text-[15px]"
                style={{ WebkitAppearance: "none", backgroundColor: canResend ? "#4A7FAE" : "#C4CDD6", color: "white" }}>
                {status === "sending" ? "Sending…" : "Resend confirmation email"}
              </button>
            </div>
          ) : (
            <div className="text-center">
              <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ backgroundColor: "#5FA663" }}>
                <Check size={22} color="white" />
              </div>
              <p className="text-[13px] font-medium text-[#3A4048]">New confirmation link sent to {email.trim()} — check your email.</p>
            </div>
          )}

          <button type="button" onClick={onDismiss} className="block mx-auto mt-6 text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
            Back to login
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function LoginScreen({ viewportH }) {
  const [step, setStep] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [rememberMe, setRememberMeChecked] = useState(getRememberMe());
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);

  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [notConfirmed, setNotConfirmed] = useState(false); // login failed specifically because the account isn't confirmed yet
  const [resendStatus, setResendStatus] = useState(null); // null | "sending" | "sent" | <error message>

  const canSubmit = email.trim().length > 3 && password.length >= 6;

  // No separate onSuccess call needed after either of these: a successful sign-in/sign-up
  // updates the Supabase session, which flows into the root App component's `session` state
  // via its onAuthStateChange listener and takes it off this screen on its own.
  const login = async () => {
    if (!canSubmit) return;
    setAuthError(null);
    setNotConfirmed(false);
    setResendStatus(null);
    setSubmitting(true);
    try {
      setRememberMe(rememberMe); // decides whether the session below lands in localStorage or sessionStorage
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        setAuthError(error.message);
        if (error.code === "email_not_confirmed") setNotConfirmed(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const resendConfirmation = async (targetEmail) => {
    const trimmed = (targetEmail || "").trim();
    if (trimmed.length <= 3 || resendStatus === "sending") return;
    setResendStatus("sending");
    const { error } = await supabase.auth.resend({
      type: "signup", email: trimmed, options: { emailRedirectTo: getEmailRedirectTo() },
    });
    setResendStatus(error ? error.message : "sent");
  };

  const signup = async () => {
    setAuthError(null);
    setSubmitting(true);
    try {
      setRememberMe(rememberMe);
      const { data, error } = await supabase.auth.signUp({
        email: signupEmail.trim(), password: signupPassword,
        options: { data: { full_name: signupName.trim() }, emailRedirectTo: getEmailRedirectTo() },
      });
      if (error) { setAuthError(error.message); return; }
      if (!data.session) setStep("confirm-email");
    } finally {
      setSubmitting(false);
    }
  };

  const sendReset = async () => {
    if (forgotEmail.trim().length <= 3) return;
    // Attempt it, but show the same "check your email" copy either way — confirming or
    // denying that an email failed would let this screen be used to enumerate accounts.
    try { await supabase.auth.resetPasswordForEmail(forgotEmail.trim()); } catch { /* see above */ }
    setForgotSent(true);
  };

  return (
    <div className="flex justify-center" style={{ fontFamily: "-apple-system, sans-serif", minHeight: viewportH, backgroundColor: "#F7F9FB" }}>
      <div className="w-full max-w-[420px] relative overflow-hidden flex flex-col" style={{ height: viewportH, backgroundColor: "#F7F9FB" }}>
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 flex flex-col justify-center">
          {step === "login" && (
            <div>
              <div className="mb-6 text-center">
                <img src="data:image/png;base64,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" alt="E.S.C. logo" className="w-40 mx-auto mb-1 object-contain" />
                <h1 className="font-display text-[26px] text-[#3A4048]">Welcome back</h1>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); login(); }} className="flex flex-col gap-3">
                <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  <Mail size={17} color="#8A94A0" />
                  <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
                    className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
                </label>
                <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  <Lock size={17} color="#8A94A0" />
                  <input type={showPassword ? "text" : "password"} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
                    className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} style={{ WebkitAppearance: "none", backgroundColor: "transparent" }}>
                    {showPassword ? <EyeOff size={17} color="#8A94A0" /> : <Eye size={17} color="#8A94A0" />}
                  </button>
                </label>
                <button type="button" onClick={() => setRememberMeChecked((v) => !v)} className="flex items-center gap-2 px-0.5" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                  <div className="w-[18px] h-[18px] rounded-md flex items-center justify-center shrink-0" style={{ border: `1.5px solid ${rememberMe ? "#4A7FAE" : "#C4CDD6"}`, backgroundColor: rememberMe ? "#4A7FAE" : "white" }}>
                    {rememberMe && <Check size={12} color="white" />}
                  </div>
                  <span className="text-[13px] text-[#3A4048]">Remember me on this device</span>
                </button>
                {authError && <p className="text-[12px] font-medium text-[#C67B6C] px-0.5">{authError}</p>}
                {notConfirmed && resendStatus !== "sent" && (
                  <button type="button" onClick={() => resendConfirmation(email)} disabled={resendStatus === "sending"}
                    className="text-[12px] font-semibold text-[#4A7FAE] px-0.5 text-left" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                    {resendStatus === "sending" ? "Sending…" : "Resend confirmation email"}
                  </button>
                )}
                {resendStatus === "sent" && <p className="text-[12px] font-medium text-[#5FA663] px-0.5">New confirmation link sent — check your email.</p>}
                {resendStatus && resendStatus !== "sending" && resendStatus !== "sent" && (
                  <p className="text-[12px] font-medium text-[#C67B6C] px-0.5">{resendStatus}</p>
                )}
                <button type="submit" disabled={!canSubmit || submitting} className="mt-1 rounded-2xl py-3.5 flex items-center justify-center gap-2 font-semibold text-[15px]"
                  style={{ WebkitAppearance: "none", backgroundColor: canSubmit && !submitting ? "#4A7FAE" : "#C4CDD6", color: "white" }}>
                  {submitting ? "Logging in…" : <>Log in <ArrowRight size={17} /></>}
                </button>
              </form>
              <button type="button" onClick={() => setStep("forgot")} className="block mx-auto text-[13px] font-medium text-[#4A7FAE] mt-4" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                Forgot password?
              </button>
              <button type="button" onClick={() => { setStep("signup"); setAuthError(null); setNotConfirmed(false); setResendStatus(null); }} className="block mx-auto text-[13px] text-[#8A94A0] mt-3" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                New here? <span className="font-semibold text-[#4A7FAE]">Create a household</span>
              </button>
            </div>
          )}

          {step === "forgot" && (
            <div>
              <button onClick={() => { setStep("login"); setForgotSent(false); }} className="mb-4" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                <ChevronLeft size={20} color="#4A7FAE" />
              </button>

              {!forgotSent ? (
                <>
                  <h1 className="font-display text-[24px] text-[#3A4048] mb-1">Reset your password</h1>
                  <p className="text-[13px] text-[#8A94A0] mb-5">Enter the email on your account and we'll send a reset link.</p>
                  <label className="rounded-2xl px-4 py-3 flex items-center gap-3 mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                    <Mail size={17} color="#8A94A0" />
                    <input type="email" placeholder="Email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)}
                      className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
                  </label>
                  <button
                    onClick={sendReset}
                    disabled={forgotEmail.trim().length <= 3}
                    className="w-full rounded-2xl py-3.5 font-semibold text-[15px]"
                    style={{ WebkitAppearance: "none", backgroundColor: forgotEmail.trim().length > 3 ? "#4A7FAE" : "#C4CDD6", color: "white" }}
                  >
                    Send reset link
                  </button>
                </>
              ) : (
                <div className="text-center pt-6">
                  <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: "#5FA663" }}>
                    <Check size={24} color="white" />
                  </div>
                  <h1 className="font-display text-[22px] text-[#3A4048] mb-2">Check your email</h1>
                  <p className="text-[13px] text-[#8A94A0] mb-6">If an account exists for <span className="font-semibold text-[#3A4048]">{forgotEmail}</span>, a reset link is on its way.</p>
                  <button onClick={() => setStep("login")} className="text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                    Back to login
                  </button>
                </div>
              )}
            </div>
          )}

          {step === "signup" && (
            <div>
              <button onClick={() => setStep("login")} className="mb-4" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                <ChevronLeft size={20} color="#4A7FAE" />
              </button>
              <h1 className="font-display text-[24px] text-[#3A4048] mb-1">Create a household</h1>
              <p className="text-[13px] text-[#8A94A0] mb-5">You'll be the owner — you can invite other caregivers once you're set up.</p>

              <div className="flex flex-col gap-3">
                <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  <User size={17} color="#8A94A0" />
                  <input placeholder="Your name" value={signupName} onChange={(e) => setSignupName(e.target.value)}
                    className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
                </label>
                <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  <Mail size={17} color="#8A94A0" />
                  <input type="email" placeholder="Email" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)}
                    className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
                </label>
                <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  <Lock size={17} color="#8A94A0" />
                  <input type={showSignupPassword ? "text" : "password"} placeholder="Password (6+ characters)" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)}
                    className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
                  <button type="button" onClick={() => setShowSignupPassword((v) => !v)} style={{ WebkitAppearance: "none", backgroundColor: "transparent" }}>
                    {showSignupPassword ? <EyeOff size={17} color="#8A94A0" /> : <Eye size={17} color="#8A94A0" />}
                  </button>
                </label>

                <button type="button" onClick={() => setAgreedToTerms((v) => !v)} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl text-left"
                  style={{ backgroundColor: agreedToTerms ? "rgba(74,127,174,0.08)" : "white", border: `1px solid ${agreedToTerms ? "#4A7FAE" : "#DCEAF5"}`, WebkitAppearance: "none" }}>
                  <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ border: `1.5px solid ${agreedToTerms ? "#4A7FAE" : "#C4CDD6"}`, backgroundColor: agreedToTerms ? "#4A7FAE" : "white" }}>
                    {agreedToTerms && <Check size={13} color="white" />}
                  </div>
                  <span className="text-[13px] text-[#3A4048] leading-snug">
                    I agree to the <span className="font-semibold text-[#4A7FAE]">Terms of Service</span> and <span className="font-semibold text-[#4A7FAE]">Privacy Policy</span>
                  </span>
                </button>

                {authError && <p className="text-[12px] font-medium text-[#C67B6C] px-0.5">{authError}</p>}
                <button
                  onClick={signup}
                  disabled={!(signupName.trim() && signupEmail.trim().length > 3 && signupPassword.length >= 6 && agreedToTerms) || submitting}
                  className="mt-1 rounded-2xl py-3.5 font-semibold text-[15px]"
                  style={{
                    WebkitAppearance: "none",
                    backgroundColor: (signupName.trim() && signupEmail.trim().length > 3 && signupPassword.length >= 6 && agreedToTerms && !submitting) ? "#4A7FAE" : "#C4CDD6",
                    color: "white",
                  }}
                >
                  {submitting ? "Creating…" : "Create household"}
                </button>
              </div>
              <p className="text-[11px] text-[#B7C3CC] mt-4 leading-relaxed">
                This is a preview build — the Terms of Service and Privacy Policy links above aren't wired to real documents yet, that needs actual legal drafting before this ships, not placeholder text.
              </p>
            </div>
          )}

          {step === "confirm-email" && (
            <div className="text-center pt-6">
              <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: "#5FA663" }}>
                <Mail size={24} color="white" />
              </div>
              <h1 className="font-display text-[22px] text-[#3A4048] mb-2">Check your email</h1>
              <p className="text-[13px] text-[#8A94A0] mb-6">
                We sent a confirmation link to <span className="font-semibold text-[#3A4048]">{signupEmail.trim()}</span>. Click it, then log in below.
              </p>
              {resendStatus === "sent" ? (
                <p className="text-[12px] font-medium text-[#5FA663] mb-4">New confirmation link sent — check your email.</p>
              ) : (
                <button onClick={() => resendConfirmation(signupEmail)} disabled={resendStatus === "sending"} className="block mx-auto text-[13px] font-semibold text-[#4A7FAE] mb-4"
                  style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                  {resendStatus === "sending" ? "Sending…" : "Didn't get it? Resend confirmation email"}
                </button>
              )}
              {resendStatus && resendStatus !== "sending" && resendStatus !== "sent" && (
                <p className="text-[12px] font-medium text-[#C67B6C] mb-4">{resendStatus}</p>
              )}
              <button onClick={() => { setStep("login"); setEmail(signupEmail.trim()); setResendStatus(null); }} className="text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                Back to login
              </button>
            </div>
          )}

        </div>
        {/* NOTE: this line describes the target architecture, not this prototype's actual implementation.
            Do not ship literal "encrypted" / "never leaves this device" claims until a real security
            review confirms they're true — false security claims are a real liability, not just copy. */}
        <p className="text-center text-[11px] text-[#B7C3CC] pb-6">This is an early preview — not yet reviewed for production security</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create a household — shown once authed if the account has no household yet:
// a brand-new install, or every household having been deleted. This is the
// only place a household actually gets created.
// ---------------------------------------------------------------------------
function CreateHouseholdScreen({ viewportH, onCreate, onLogout, dbError, onDismissError }) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const canSubmit = name.trim().length > 0 && !creating;

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      await onCreate(name); // swallows its own errors into dbError; this just re-enables the form after
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex justify-center" style={{ fontFamily: "-apple-system, sans-serif", minHeight: viewportH, backgroundColor: "#F7F9FB" }}>
      <div className="w-full max-w-[420px] relative overflow-hidden flex flex-col" style={{ height: viewportH, backgroundColor: "#F7F9FB" }}>
        {dbError && (
          <button onClick={onDismissError} className="flex items-center gap-2 px-4 py-2 shrink-0 text-left" style={{ backgroundColor: "#C67B6C", WebkitAppearance: "none" }}>
            <AlertTriangle size={14} color="white" className="shrink-0" />
            <span className="text-[12px] font-semibold text-white flex-1">{dbError}</span>
            <X size={14} color="white" className="shrink-0" />
          </button>
        )}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 flex flex-col justify-center">
          <div className="mb-6 text-center">
            <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: "rgba(74,127,174,0.12)" }}>
              <Home size={24} color="#4A7FAE" />
            </div>
            <h1 className="font-display text-[24px] text-[#3A4048] mb-1">Create your household</h1>
            <p className="text-[13px] text-[#8A94A0]">You're the owner — add children and invite other caregivers once you're set up.</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3">
            <label className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
              <Users size={17} color="#8A94A0" />
              <input placeholder="Household name (e.g. The Rivera Family)" value={name} onChange={(e) => setName(e.target.value)}
                className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
            </label>
            <button type="submit" disabled={!canSubmit} className="rounded-2xl py-3.5 flex items-center justify-center gap-2 font-semibold text-[15px]"
              style={{ WebkitAppearance: "none", backgroundColor: canSubmit ? "#4A7FAE" : "#C4CDD6", color: "white" }}>
              {creating ? "Creating…" : <>Create household <ArrowRight size={17} /></>}
            </button>
          </form>
          <button type="button" onClick={onLogout} className="flex items-center justify-center gap-1.5 mx-auto mt-6 text-[13px] font-medium text-[#8A94A0]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
            <LogOut size={14} /> Log out
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------
function TodayScreen({ household, childId, setChildId, careItems, timeline, upcoming, now, onOpenQuickLog, onEditEntry, onDeleteEntry, onEditUpcoming, onDeleteUpcoming, onLogPreset, onEditPreset, onDeletePreset, myRole, speakText }) {
  const [filter, setFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState(null); // entry | null (always today's dayKey here)
  const [selectedUpcoming, setSelectedUpcoming] = useState(null);
  const [selectedPreset, setSelectedPreset] = useState(null);
  const URGENT_MS = 90 * 60 * 1000;
  const upcomingSorted = (upcoming || []).filter((u) => u.timestamp > now - 60 * 60 * 1000).sort((a, b) => a.timestamp - b.timestamp); // keep overdue-by-under-an-hour visible briefly, then it drops off

  useEffect(() => { setFilter("all"); setShowAll(false); }, [childId]);

  if (household.children.length === 0) {
    return (
      <div className="px-6 pt-16 text-center">
        <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: "rgba(74,127,174,0.12)" }}>
          <Users size={24} color="#4A7FAE" />
        </div>
        <h1 className="font-display text-[20px] text-[#3A4048] mb-1">No children yet</h1>
        <p className="text-[13px] text-[#8A94A0]">Add a child in the Household tab to start tracking their day.</p>
      </div>
    );
  }

  const withStatus = careItems.map((item) => ({ item, status: getStatus(item, now) }));
  const isFiltering = filter !== "all";
  const JUST_LOGGED_MS = 5 * 60 * 1000; // show newly-added/just-logged items immediately, even if not urgent yet
  const relevant = withStatus.filter(({ status }) => status.ready || status.remaining < URGENT_MS || status.elapsed < JUST_LOGGED_MS);
  const base = showAll || isFiltering ? withStatus : relevant;
  const visible = base.filter(({ item }) => filter === "all" || item.category === filter).sort((a, b) => a.status.remaining - b.status.remaining);

  const today = dateKey(new Date());
  const todayEntries = (timeline[today] || []).slice(-3).reverse();

  return (
    <div>
      <div className="px-5 pt-6 flex gap-2">
        {household.children.map((c) => {
          const active = c.id === childId;
          return (
            <button key={c.id} onClick={() => setChildId(c.id)} className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full"
              style={{ backgroundColor: active ? "#4A7FAE" : "white", border: active ? "none" : "1px solid #DCEAF5", WebkitAppearance: "none" }}>
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: active ? "white" : "#F7F9FB", color: "#4A7FAE" }}>{c.initials}</div>
              <span className="text-[13px] font-semibold" style={{ color: active ? "white" : "#3A4048" }}>{c.name}</span>
            </button>
          );
        })}
      </div>

      <div className="px-6 pt-4 pb-1">
        <p className="text-[13px] tracking-wide text-[#8A94A0] uppercase font-semibold">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
        <h1 className="font-display text-[24px] text-[#3A4048] mt-1">Today</h1>
      </div>

      <div className="px-5 mt-3 mb-2 flex items-center justify-between">
        <p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">
          {isFiltering ? `Showing: ${CATEGORY_META[filter].label}` : showAll ? "All care items" : "Needs attention soon"}
        </p>
      </div>
      <div className="px-5 mb-3 flex gap-1.5 overflow-x-auto">
        {["all", ...Object.keys(CATEGORY_META)].map((cat) => {
          const active = filter === cat;
          const meta = cat === "all" ? { label: "All", color: "#4A7FAE" } : CATEGORY_META[cat];
          return (
            <button key={cat} onClick={() => setFilter(cat)} className="px-3 py-1 rounded-full text-[12px] font-semibold whitespace-nowrap shrink-0"
              style={{ backgroundColor: active ? meta.color : "white", color: active ? "white" : meta.color, border: `1px solid ${active ? meta.color : "#DCEAF5"}`, WebkitAppearance: "none" }}>
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="mx-5 rounded-3xl overflow-hidden mb-2" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {visible.length === 0 && <div className="px-5 py-6 text-center"><p className="text-[13px] text-[#8A94A0]">Nothing needs attention right now.</p></div>}
        {visible.map(({ item, status }, i) => {
          const meta = CATEGORY_META[item.category];
          const Icon = meta.icon;
          return (
            <button key={item.id} onClick={() => setSelectedPreset(item)} className="w-full flex items-center gap-3 px-4 py-3 text-left"
              style={{ borderBottom: i < visible.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${status.color}` }}>
                <Icon size={14} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-[#3A4048] font-semibold truncate">{item.title}</p>
                <p className="text-[12px] text-[#8A94A0] truncate">{fmtElapsed(status.elapsed)} ago · {item.subtitle}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: status.color }}>{status.label}</p>
                <p className="tnum text-[15px] font-semibold" style={{ color: status.color }}>{status.ready ? "Now" : fmtCountdown(status.remaining)}</p>
              </div>
            </button>
          );
        })}
      </div>

      {!showAll && !isFiltering && (
        <button onClick={() => setShowAll(true)} className="mx-5 mb-6 text-[13px] font-semibold text-[#4A7FAE] flex items-center gap-1" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
          See all care items <ChevRight size={14} />
        </button>
      )}
      {(showAll || isFiltering) && (
        <button onClick={() => { setShowAll(false); setFilter("all"); }} className="mx-5 mb-6 text-[13px] font-semibold text-[#8A94A0] flex items-center gap-1" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
          <X size={14} /> Reset view
        </button>
      )}

      {upcomingSorted.length > 0 && (
        <>
          <div className="px-6 mb-2"><p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">Upcoming</p></div>
          <div className="mx-5 rounded-3xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            {upcomingSorted.map((u, i) => {
              const meta = CATEGORY_META[u.category] || CATEGORY_META.medication;
              const Icon = meta.icon;
              const diff = u.timestamp - now;
              const overdue = diff <= 0;
              const label = overdue ? "Happening now" : fmtCountdown(diff);
              const urgencyColor = overdue ? "#5FA663" : diff <= URGENCY_RED_MS ? "#C67B6C" : diff <= URGENCY_YELLOW_MS ? "#C99A4E" : "#5FA663";
              return (
                <button key={u.id} onClick={() => setSelectedUpcoming(u)} className="w-full flex items-center gap-3 px-4 py-3 text-left"
                  style={{ borderBottom: i < upcomingSorted.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${urgencyColor}` }}>
                    <Icon size={14} color={meta.color} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] text-[#3A4048] font-semibold truncate">{u.title}</p>
                    <p className="text-[12px] text-[#8A94A0] truncate">{u.subtitle || new Date(u.timestamp).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: urgencyColor }}>{overdue ? "" : "in"}</p>
                    <p className="tnum text-[13px] font-semibold" style={{ color: urgencyColor }}>{label}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="px-6 mb-2"><p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">Logged today</p></div>
      <div className="mx-5 rounded-3xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {todayEntries.length === 0 && <div className="px-5 py-6 text-center"><p className="text-[13px] text-[#8A94A0]">Nothing logged yet today.</p></div>}
        {todayEntries.map((e, i, arr) => {
          const meta = CATEGORY_META[e.category] || CATEGORY_META.medication;
          const Icon = meta.icon;
          return (
            <button key={e.id || i} onClick={() => setSelected(e)} className="w-full flex items-center gap-3 px-4 py-3 text-left"
              style={{ borderBottom: i < arr.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                <Icon size={14} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1"><p className="text-[14px] text-[#3A4048] font-semibold truncate">{e.title}</p><p className="text-[12px] text-[#8A94A0] truncate">{e.subtitle}</p></div>
              <div className="flex items-center gap-2 shrink-0">
                <p className="tnum text-[13px] text-[#8A94A0] font-medium">{e.time}</p>
                <ChevRight size={14} color="#C4CDD6" />
              </div>
            </button>
          );
        })}
      </div>

      <p className="px-6 text-[11px] text-[#B7C3CC] leading-relaxed">
        Timers reflect schedules you've entered — not medical advice. Always follow your child's doctor or pharmacist for dosing and timing.
      </p>

      {selected && (
        <EntryDetailModal
          entry={selected}
          myRole={myRole}
          speakText={speakText}
          onClose={() => setSelected(null)}
          onSave={(patch) => { onEditEntry(today, selected.id, patch); setSelected(null); }}
          onDelete={() => { onDeleteEntry(today, selected.id); setSelected(null); }}
        />
      )}

      {selectedUpcoming && (
        <UpcomingDetailModal
          item={selectedUpcoming}
          myRole={myRole}
          speakText={speakText}
          onClose={() => setSelectedUpcoming(null)}
          onSave={(patch) => { onEditUpcoming(selectedUpcoming.id, patch); setSelectedUpcoming(null); }}
          onDelete={() => { onDeleteUpcoming(selectedUpcoming.id); setSelectedUpcoming(null); }}
        />
      )}

      {selectedPreset && (
        <EditPresetModal
          item={selectedPreset}
          myRole={myRole}
          now={now}
          onClose={() => setSelectedPreset(null)}
          onSave={(patch) => { onEditPreset(selectedPreset.id, patch); setSelectedPreset(null); }}
          onDelete={() => { onDeletePreset(selectedPreset.id); setSelectedPreset(null); }}
          onLogNow={() => { onLogPreset(selectedPreset.id); setSelectedPreset(null); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
function TimelineScreen({ household, childId, setChildId, careItems, timeline, now, onEditEntry, onDeleteEntry, myRole, centerOffset, setCenterOffset, speakText }) {
  const [dragX, setDragX] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null); // { dayKey, entry } | null
  const [shareStatus, setShareStatus] = useState(""); // "" | "copied" | "shared"
  const [search, setSearch] = useState("");
  const trackRef = useRef(null);
  const widthRef = useRef(390);
  const drag = useRef({ x: 0, y: 0, active: false, horizontal: null });

  useEffect(() => { setSearch(""); setFilter("all"); setSelected(null); }, [childId]);

  const q = search.trim().toLowerCase();
  const searchActive = q.length > 0 || filter !== "all";
  const searchResults = searchActive
    ? Object.entries(timeline)
        .flatMap(([dayKey, entries]) => entries.map((e) => ({ ...e, dayKey })))
        .filter((e) => filter === "all" || e.category === filter)
        .filter((e) => !q || e.title.toLowerCase().includes(q) || (e.subtitle || "").toLowerCase().includes(q))
        .sort((a, b) => (a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0)) // most recent first
    : [];

  if (household.children.length === 0) {
    return (
      <div className="px-6 pt-16 text-center">
        <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: "rgba(74,127,174,0.12)" }}>
          <Users size={24} color="#4A7FAE" />
        </div>
        <h1 className="font-display text-[20px] text-[#3A4048] mb-1">No children yet</h1>
        <p className="text-[13px] text-[#8A94A0]">Add a child in the Household tab to start their timeline.</p>
      </div>
    );
  }

  const childName = household.children.find((c) => c.id === childId)?.name || "Child";

  const shareHistory = async () => {
    const summary = buildHistorySummary(timeline, childName, 30);
    if (navigator.share) {
      try {
        await navigator.share({ title: `${childName}'s care history`, text: summary });
        setShareStatus("shared");
      } catch {
        // user cancelled the share sheet — not an error, just do nothing
        return;
      }
    } else {
      try {
        await navigator.clipboard.writeText(summary);
        setShareStatus("copied");
      } catch {
        setShareStatus("failed");
      }
    }
    setTimeout(() => setShareStatus(""), 2000);
  };

  const onDown = useCallback((e) => {
    if (animating) return;
    widthRef.current = trackRef.current?.offsetWidth || 390;
    drag.current = { x: e.clientX, y: e.clientY, active: true, horizontal: null };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [animating]);
  const onMove = useCallback((e) => {
    const d = drag.current;
    if (!d.active) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.horizontal === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) d.horizontal = Math.abs(dx) > Math.abs(dy);
    if (d.horizontal) setDragX(dx);
  }, []);
  const settle = useCallback((dir) => {
    const width = widthRef.current;
    setAnimating(true);
    setDragX(dir === 0 ? 0 : dir === 1 ? -width : width);
    setTimeout(() => { if (dir !== 0) setCenterOffset((o) => o + dir); setDragX(0); setAnimating(false); }, 260);
  }, []);
  const onUp = useCallback((e) => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    if (!d.horizontal) { setDragX(0); return; }
    const dx = e.clientX - d.x;
    settle(Math.abs(dx) > 60 ? (dx < 0 ? 1 : -1) : 0);
  }, [settle]);

  const labelFor = (offset) => {
    if (offset === 0) return "Today";
    if (offset === -1) return "Yesterday";
    if (offset === 1) return "Tomorrow";
    return addDays(new Date(), offset).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  };
  const jumpToDate = (dateStr) => {
    const target = new Date(dateStr + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const offset = Math.round((target - today) / 86400000);
    setCenterOffset(offset);
    setDragX(0);
    speakText?.(`Jumped to ${labelFor(offset)}`);
  };

  const pages = [centerOffset - 1, centerOffset, centerOffset + 1];
  const trackStyle = { transform: `translateX(calc(-${widthRef.current}px + ${dragX}px))`, transition: animating ? "transform 260ms cubic-bezier(0.22,0.61,0.36,1)" : "none" };

  return (
    <div>
      <div className="px-5 pt-6 flex items-center justify-between gap-2">
        <div className="flex gap-2 overflow-x-auto">
          {household.children.map((c) => {
            const active = c.id === childId;
            return (
              <button key={c.id} onClick={() => setChildId(c.id)} className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full shrink-0"
                style={{ backgroundColor: active ? "#4A7FAE" : "white", border: active ? "none" : "1px solid #DCEAF5", WebkitAppearance: "none" }}>
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: active ? "white" : "#F7F9FB", color: "#4A7FAE" }}>{c.initials}</div>
                <span className="text-[13px] font-semibold" style={{ color: active ? "white" : "#3A4048" }}>{c.name}</span>
              </button>
            );
          })}
        </div>
        <button onClick={shareHistory} className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: "1px solid #DCEAF5", WebkitAppearance: "none" }} aria-label="Share history">
          <Share2 size={15} color="#4A7FAE" />
        </button>
      </div>
      {shareStatus && (
        <p className="px-5 mt-2 text-[12px] font-semibold text-[#5FA663]">
          {shareStatus === "copied" ? "Copied last 30 days to clipboard." : shareStatus === "shared" ? "Shared." : "Couldn't copy — try again."}
        </p>
      )}

      <div className="px-6 pt-4 pb-2 flex items-center justify-between">
        <button onClick={() => !animating && settle(-1)} className="w-8 h-8 rounded-full flex items-center justify-center active:scale-95 transition-transform" style={{ backgroundColor: "white", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>
          <ChevronLeft size={16} color="#4A7FAE" />
        </button>
        <h1 className="font-display text-[20px] text-[#3A4048] leading-tight">{labelFor(centerOffset)}</h1>
        <button onClick={() => !animating && settle(1)} className="w-8 h-8 rounded-full flex items-center justify-center active:scale-95 transition-transform" style={{ backgroundColor: "white", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>
          <ChevronRight size={16} color="#4A7FAE" />
        </button>
      </div>

      <div className="mx-5 mb-3 rounded-2xl p-3 flex items-center gap-2" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        <Calendar size={13} color="#4A7FAE" />
        <span className="text-[12px] font-semibold text-[#4A7FAE]">Jump to a date</span>
        <input type="date" value={dateKey(addDays(new Date(), centerOffset))} onChange={(e) => jumpToDate(e.target.value)}
          className="ml-auto text-[13px] px-2 py-1 rounded-lg text-[#3A4048]" style={{ border: "1px solid #DCEAF5" }} />
      </div>

      <div className="mx-5 mb-3 rounded-2xl px-3 py-2.5 flex items-center gap-2" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        <Search size={14} color="#8A94A0" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this history — e.g. Advil, OT class"
          className="flex-1 text-[14px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
        {search && <button onClick={() => setSearch("")} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={14} color="#8A94A0" /></button>}
      </div>

      <div className="px-5 mb-3 flex gap-1.5 overflow-x-auto">
        {["all", ...Object.keys(CATEGORY_META)].map((cat) => {
          const active = filter === cat;
          const meta = cat === "all" ? { label: "All", color: "#4A7FAE" } : CATEGORY_META[cat];
          return (
            <button key={cat} onClick={() => setFilter(cat)} className="px-3 py-1 rounded-full text-[12px] font-semibold whitespace-nowrap shrink-0"
              style={{ backgroundColor: active ? meta.color : "white", color: active ? "white" : meta.color, border: `1px solid ${active ? meta.color : "#DCEAF5"}`, WebkitAppearance: "none" }}>
              {meta.label}
            </button>
          );
        })}
      </div>

      {searchActive ? (
        <div className="mx-5 rounded-3xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
          {searchResults.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-[13px] text-[#8A94A0]">{q ? `No matches for "${search.trim()}".` : `No ${CATEGORY_META[filter].label.toLowerCase()} entries logged yet.`}</p>
            </div>
          )}
          {searchResults.map((e, i) => {
            const meta = CATEGORY_META[e.category] || CATEGORY_META.medication;
            const Icon = meta.icon;
            return (
              <button key={e.id || i} onClick={() => setSelected({ dayKey: e.dayKey, entry: e })} className="w-full flex items-center gap-3 px-4 py-3 text-left"
                style={{ borderBottom: i < searchResults.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
                <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                  <Icon size={14} color={meta.color} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] text-[#3A4048] font-semibold truncate">{e.title}</p>
                  <p className="text-[12px] text-[#8A94A0] truncate">{formatEntryDate(e.dayKey)} · {e.subtitle}</p>
                </div>
                <p className="tnum text-[12px] text-[#8A94A0] font-medium shrink-0">{e.time}</p>
              </button>
            );
          })}
        </div>
      ) : (
        <div ref={trackRef} className="relative select-none touch-pan-y" style={{ overflow: "hidden" }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="flex" style={trackStyle}>
            {pages.map((offset) => (
              <div key={offset} className="w-full shrink-0 px-5" style={{ width: "100%" }}>
                <DayCard offset={offset} entries={timeline[dateKey(addDays(new Date(), offset))] || []}
                  onSelect={(entry) => setSelected({ dayKey: dateKey(addDays(new Date(), offset)), entry })} />
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <EntryDetailModal
          entry={selected.entry}
          myRole={myRole}
          speakText={speakText}
          onClose={() => setSelected(null)}
          onSave={(patch) => { onEditEntry(selected.dayKey, selected.entry.id, patch); setSelected(null); }}
          onDelete={() => { onDeleteEntry(selected.dayKey, selected.entry.id); setSelected(null); }}
        />
      )}
    </div>
  );
}

function DayCard({ offset, entries, onSelect }) {
  const label = offset === 0 ? "Today" : offset === -1 ? "Yesterday" : offset === 1 ? "Tomorrow"
    : addDays(new Date(), offset).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return (
    <div>
      <p className="text-[12px] font-semibold tracking-wide uppercase text-[#4A7FAE] mb-2 text-center">{label}</p>
      <div className="rounded-3xl overflow-hidden min-h-[200px]" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {entries.length === 0 && <div className="px-5 py-10 text-center"><p className="text-[13px] text-[#8A94A0]">No entries logged for this day.</p></div>}
        {entries.map((e, i) => {
          const meta = CATEGORY_META[e.category] || CATEGORY_META.medication;
          const Icon = meta.icon;
          return (
            <button key={e.id || i} onClick={() => onSelect(e)} className="w-full flex items-center gap-3 px-4 py-3 text-left"
              style={{ borderBottom: i < entries.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                <Icon size={14} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-[#3A4048] font-semibold truncate">{e.title}</p>
                <p className="text-[12px] text-[#8A94A0] truncate">{e.subtitle}</p>
              </div>
              <p className="tnum text-[12px] text-[#8A94A0] font-medium shrink-0">{e.time}</p>
              <ChevRight size={14} color="#C4CDD6" className="shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view for a scheduled (future, one-time) event — view/edit/delete,
// same shape as EntryDetailModal but with a real date+time instead of a
// same-day time string, since this represents something that hasn't happened yet.
// ---------------------------------------------------------------------------
function UpcomingDetailModal({ item, myRole, onClose, onSave, onDelete, speakText }) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(item.category);
  const [title, setTitle] = useState(item.title);
  const [subtitle, setSubtitle] = useState(item.subtitle || "");
  const [notes, setNotes] = useState(item.notes || "");
  const [recurrence, setRecurrence] = useState(item.recurrence || "none");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = new Date(item.timestamp);
  const [date, setDate] = useState(dateKey(d));
  const [time, setTime] = useState(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  const meta = CATEGORY_META[category] || CATEGORY_META.medication;
  const Icon = meta.icon;
  const canWrite = myRole !== "view";
  const canSave = title.trim().length > 0;
  const RECURRENCE_LABEL = { none: "One time", weekly: "Weekly", monthly: "Monthly" };

  const save = () => {
    if (!canSave) return;
    const [y, m, dd] = date.split("-").map(Number);
    const [h, min] = time.split(":").map(Number);
    const timestamp = new Date(y, m - 1, dd, h, min, 0, 0).getTime();
    onSave({ category, title: title.trim(), subtitle: subtitle.trim(), notes: notes.trim(), timestamp, recurrence });
  };

  return (
    <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 50 }} onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[19px] text-[#3A4048]">{editing ? "Edit scheduled event" : "Scheduled"}</h2>
          <button onClick={onClose} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
        </div>

        {!editing ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                <Icon size={20} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[17px] text-[#3A4048] font-semibold truncate">{item.title}</p>
                <p className="text-[13px] text-[#8A94A0] truncate">{item.subtitle}</p>
              </div>
            </div>
            <div className="rounded-2xl overflow-hidden mb-6" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Category</span>
                <span className="text-[13px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: item.notes ? "1px solid #EEF3F7" : "none" }}>
                <span className="text-[12px] text-[#8A94A0]">When</span>
                <span className="tnum text-[13px] font-medium text-[#3A4048]">{new Date(item.timestamp).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: item.notes ? "1px solid #EEF3F7" : "none" }}>
                <span className="text-[12px] text-[#8A94A0]">Repeats</span>
                <span className="text-[13px] font-medium text-[#3A4048]">{RECURRENCE_LABEL[item.recurrence || "none"]}</span>
              </div>
              {item.notes && (
                <div className="px-4 py-2.5">
                  <span className="text-[12px] text-[#8A94A0] block mb-1">Notes</span>
                  <span className="text-[13px] text-[#3A4048]">{item.notes}</span>
                </div>
              )}
            </div>
            {canWrite ? (
              !confirmDelete ? (
                <div className="flex gap-2">
                  <button onClick={() => setEditing(true)} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>Edit</button>
                  <button onClick={() => setConfirmDelete(true)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>Delete</button>
                </div>
              ) : (
                <div className="rounded-2xl p-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                  <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Delete this? This can't be undone.</p>
                  <div className="flex gap-2">
                    <button onClick={onDelete} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Delete</button>
                    <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                  </div>
                </div>
              )
            ) : (
              <p className="text-[12px] text-[#B7C3CC] text-center">View-only access — ask an owner or full-access caregiver to make changes.</p>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
              <div className="flex gap-1.5 flex-wrap">
                {Object.entries(CATEGORY_META).map(([key, m]) => (
                  <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: category === key ? m.color : "#F2F7FB", color: category === key ? "white" : m.color }}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">What's happening</p>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Details</p>
              <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Date</p>
                <input type="date" value={date} onChange={(e) => {
                  setDate(e.target.value);
                  speakText?.(`Date set to ${new Date(e.target.value + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`);
                }}
                  className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
              </div>
              <div className="flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Time</p>
                <input type="time" value={time} onChange={(e) => { setTime(e.target.value); speakText?.(`Time set to ${formatTimeForSpeech(e.target.value)}`); }}
                  className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Repeats</p>
              <div className="flex gap-1.5">
                {[["none", "Just once"], ["weekly", "Weekly"], ["monthly", "Monthly"]].map(([key, label]) => (
                  <button key={key} onClick={() => setRecurrence(key)} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: recurrence === key ? "#4A7FAE" : "white", color: recurrence === key ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Notes</p>
              <input value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div className="flex gap-2 mt-1">
              <button onClick={save} disabled={!canSave} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]"
                style={{ WebkitAppearance: "none", backgroundColor: canSave ? "#4A7FAE" : "#C4CDD6", color: "white" }}>Save</button>
              <button onClick={() => setEditing(false)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EntryDetailModal({ entry, onClose, onSave, onDelete, myRole, speakText }) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(entry.category);
  const [title, setTitle] = useState(entry.title);
  const [subtitle, setSubtitle] = useState(entry.subtitle || "");
  const [time, setTime] = useState(() => timeDisplayTo24h(entry.time));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canWrite = myRole !== "view";

  const meta = CATEGORY_META[category] || CATEGORY_META.medication;
  const Icon = meta.icon;
  const canSave = title.trim().length > 0 && time.length > 0;

  const save = () => {
    if (!canSave) return;
    onSave({ category, title: title.trim(), subtitle: subtitle.trim(), time: time24hToDisplay(time) });
  };

  return (
    <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 50 }} onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[19px] text-[#3A4048]">{editing ? "Edit entry" : "Entry"}</h2>
          <button onClick={onClose} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
        </div>

        {!editing ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                <Icon size={20} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[17px] text-[#3A4048] font-semibold truncate">{entry.title}</p>
                <p className="text-[13px] text-[#8A94A0] truncate">{entry.subtitle}</p>
              </div>
            </div>

            <div className="rounded-2xl overflow-hidden mb-6" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Category</span>
                <span className="text-[13px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Date</span>
                <span className="tnum text-[13px] font-medium text-[#3A4048]">{formatEntryDate(entry.date)}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Time</span>
                <span className="tnum text-[13px] font-medium text-[#3A4048]">{entry.time}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[12px] text-[#8A94A0]">Logged by</span>
                <span className="text-[13px] font-medium text-[#3A4048]">{entry.loggedBy || "Unknown"}</span>
              </div>
            </div>

            {canWrite ? (
              !confirmDelete ? (
                <div className="flex gap-2">
                  <button onClick={() => setEditing(true)} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>Edit</button>
                  <button onClick={() => setConfirmDelete(true)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>Delete</button>
                </div>
              ) : (
                <div className="rounded-2xl p-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                  <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Delete this entry? This can't be undone.</p>
                  <div className="flex gap-2">
                    <button onClick={onDelete} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Delete</button>
                    <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                  </div>
                </div>
              )
            ) : (
              <p className="text-[12px] text-[#B7C3CC] text-center">View-only access — ask an owner or full-access caregiver to make changes.</p>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
              <div className="flex gap-1.5 flex-wrap">
                {Object.entries(CATEGORY_META).map(([key, m]) => (
                  <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: category === key ? m.color : "#F2F7FB", color: category === key ? "white" : m.color }}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">What happened</p>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Details</p>
              <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Time</p>
              <input type="time" value={time} onChange={(e) => { setTime(e.target.value); speakText?.(`Time set to ${formatTimeForSpeech(e.target.value)}`); }}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div className="flex gap-2 mt-1">
              <button onClick={save} disabled={!canSave} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]"
                style={{ WebkitAppearance: "none", backgroundColor: canSave ? "#4A7FAE" : "#C4CDD6", color: "white" }}>Save</button>
              <button onClick={() => setEditing(false)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info Bank — reference library. Inspired by OurFamilyWizard's tile-grid Info
// Bank, adapted to what a caregiver of a child with disabilities actually
// needs fast: providers, schools, emergency contacts, therapies.
// ---------------------------------------------------------------------------
const INFO_CATEGORY_META = {
  emergency: { label: "Emergency", icon: AlertTriangle, color: "#C67B6C" },
  provider: { label: "Health Providers", icon: HeartPulse, color: "#B4718A" },
  insurance: { label: "Insurance", icon: Shield, color: "#4A7FAE" },
  school: { label: "School", icon: GraduationCap, color: "#4A96A3" },
  teacher: { label: "Teachers", icon: User, color: "#C99A4E" },
  therapy: { label: "Therapies & Activities", icon: Activity, color: "#7BA88A" },
  childcare: { label: "Child Care", icon: Users, color: "#8A7FC4" },
  other: { label: "Other Contacts", icon: FolderKanban, color: "#8A94A0" },
};

function InfoBankScreen({ infoBank, persistInfoBank, myRole, onBack, households, activeHouseholdId, switchHousehold, kids }) {
  const [activeCategory, setActiveCategory] = useState(null); // null = grid view
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const canWrite = myRole !== "view";

  const q = search.trim().toLowerCase();
  const matchingCategories = q ? Object.entries(INFO_CATEGORY_META).filter(([, meta]) => meta.label.toLowerCase().includes(q)) : [];
  const matchingContacts = q ? infoBank.filter((c) => c.name.toLowerCase().includes(q) || (c.subtitle || "").toLowerCase().includes(q)) : [];

  const addContact = async (contact) => {
    await persistInfoBank([...infoBank, { id: uid(), ...contact }]);
    setAddOpen(false);
  };
  const saveContact = async (id, patch) => {
    await persistInfoBank(infoBank.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setSelected(null);
  };
  const deleteContact = async (id) => {
    await persistInfoBank(infoBank.filter((c) => c.id !== id));
    setSelected(null);
  };

  // ---- Category grid (landing view) ----
  if (!activeCategory) {
    return (
      <div>
        <div className="px-6 pt-8 pb-5 text-center">
          <p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">Reference</p>
          <h1 className="font-display text-[24px] text-[#3A4048]">Info Bank</h1>
        </div>

        {households.length > 1 && (
          <div className="px-5 mb-5 flex gap-2 overflow-x-auto justify-center">
            {households.map((h) => {
              const active = h.id === activeHouseholdId;
              return (
                <button key={h.id} onClick={() => switchHousehold(h.id)} className="px-3.5 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap shrink-0"
                  style={{ backgroundColor: active ? "#4A7FAE" : "white", color: active ? "white" : "#4A7FAE", border: active ? "none" : "1px solid #DCEAF5", WebkitAppearance: "none" }}>
                  {h.name}
                </button>
              );
            })}
          </div>
        )}

        <div className="px-5 grid grid-cols-4 gap-y-5 gap-x-2">
          {Object.entries(INFO_CATEGORY_META).map(([key, meta]) => {
            const Icon = meta.icon;
            const count = infoBank.filter((c) => c.category === key).length;
            return (
              <button key={key} onClick={() => setActiveCategory(key)} className="flex flex-col items-center gap-2" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                <div className="relative">
                  <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ backgroundColor: "#F2F7FB" }}>
                    <Icon size={24} color={meta.color} />
                  </div>
                  {count > 0 && (
                    <div className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center" style={{ backgroundColor: "#4A7FAE" }}>
                      <span className="text-[10px] font-bold text-white leading-none">{count}</span>
                    </div>
                  )}
                </div>
                <span className="text-[11px] font-medium text-[#3A4048] text-center leading-tight">{meta.label}</span>
              </button>
            );
          })}
        </div>

        <div className="px-5 mt-6 mb-3">
          <div className="flex items-center gap-2 rounded-2xl px-4 py-2.5" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            <Search size={16} color="#8A94A0" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or category"
              className="flex-1 text-[14px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={15} color="#8A94A0" /></button>
            )}
          </div>
        </div>

        {q ? (
          <div className="px-5">
            {matchingCategories.length === 0 && matchingContacts.length === 0 && (
              <p className="text-[13px] text-[#8A94A0] text-center py-4">No matches for "{search.trim()}".</p>
            )}

            {matchingCategories.length > 0 && (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Categories</p>
                <div className="rounded-2xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  {matchingCategories.map(([key, meta], i) => {
                    const Icon = meta.icon;
                    return (
                      <button key={key} onClick={() => { setActiveCategory(key); setSearch(""); }} className="w-full flex items-center gap-3 px-4 py-3 text-left"
                        style={{ borderBottom: i < matchingCategories.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
                        <Icon size={16} color={meta.color} />
                        <span className="text-[14px] font-semibold text-[#3A4048] flex-1">{meta.label}</span>
                        <ChevRight size={14} color="#C4CDD6" />
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {matchingContacts.length > 0 && (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Contacts</p>
                <div className="rounded-2xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
                  {matchingContacts.map((c, i) => {
                    const meta = INFO_CATEGORY_META[c.category] || INFO_CATEGORY_META.other;
                    const Icon = meta.icon;
                    return (
                      <button key={c.id} onClick={() => setSelected(c)} className="w-full flex items-center gap-3 px-4 py-3 text-left"
                        style={{ borderBottom: i < matchingContacts.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
                        <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                          <Icon size={16} color={meta.color} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[14px] text-[#3A4048] font-semibold truncate">{c.name}</p>
                          <p className="text-[12px] text-[#8A94A0] truncate">{meta.label}{c.subtitle ? ` · ${c.subtitle}` : ""}</p>
                        </div>
                        <KidTags contact={c} kids={kids} />
                        <ChevRight size={14} color="#C4CDD6" className="shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="px-6 text-[12px] text-[#B7C3CC] text-center leading-relaxed">
            Tap a category to see contacts, or add a new one there.
          </p>
        )}

        {selected && (
          <ContactDetailModal
            contact={selected}
            canWrite={canWrite}
            kids={kids}
            onClose={() => setSelected(null)}
            onSave={(patch) => saveContact(selected.id, patch)}
            onDelete={() => deleteContact(selected.id)}
          />
        )}
      </div>
    );
  }

  // ---- Inside a category ----
  const meta = INFO_CATEGORY_META[activeCategory];
  const CatIcon = meta.icon;
  const visible = infoBank.filter((c) => c.category === activeCategory);

  return (
    <div>
      <div className="px-6 pt-8 pb-4 flex items-center gap-3">
        <button onClick={() => setActiveCategory(null)} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><ChevronLeft size={20} color="#4A7FAE" /></button>
        <div className="flex items-center gap-2">
          <CatIcon size={18} color={meta.color} />
          <h1 className="font-display text-[20px] text-[#3A4048]">{meta.label}</h1>
        </div>
      </div>

      <div className="mx-5 rounded-3xl overflow-hidden mb-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {visible.length === 0 && (
          <div className="px-5 py-8 text-center"><p className="text-[13px] text-[#8A94A0]">Nothing saved in {meta.label} yet.</p></div>
        )}
        {visible.map((c, i) => (
          <button key={c.id} onClick={() => setSelected(c)} className="w-full flex items-center gap-3 px-4 py-3 text-left"
            style={{ borderBottom: i < visible.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
              <CatIcon size={16} color={meta.color} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] text-[#3A4048] font-semibold truncate">{c.name}</p>
              <p className="text-[12px] text-[#8A94A0] truncate">{c.subtitle}</p>
            </div>
            <KidTags contact={c} kids={kids} />
            <ChevRight size={14} color="#C4CDD6" className="shrink-0" />
          </button>
        ))}
      </div>

      {canWrite ? (
        !addOpen ? (
          <div className="mx-5">
            <button onClick={() => setAddOpen(true)} className="w-full box-border rounded-2xl border-2 border-dashed py-3 flex items-center justify-center gap-2"
              style={{ backgroundColor: "#F7F9FB", borderColor: "#4A7FAE", WebkitAppearance: "none" }}>
              <Plus size={15} color="#4A7FAE" /><span className="text-[13px] font-semibold text-[#4A7FAE]">Add to {meta.label}</span>
            </button>
          </div>
        ) : (
          <AddContactForm defaultCategory={activeCategory} onAdd={addContact} onCancel={() => setAddOpen(false)} kids={kids} />
        )
      ) : (
        <p className="mx-5 text-[12px] text-[#B7C3CC]">View-only access — ask an owner or full-access caregiver to add contacts.</p>
      )}

      {selected && (
        <ContactDetailModal
          contact={selected}
          canWrite={canWrite}
          kids={kids}
          onClose={() => setSelected(null)}
          onSave={(patch) => saveContact(selected.id, patch)}
          onDelete={() => deleteContact(selected.id)}
        />
      )}
    </div>
  );
}

// Small initials-chip badges shown on a contact row, so with multiple kids in a
// household it's clear at a glance who a contact belongs to. Untagged (general/
// shared) contacts show nothing — the badge is only for narrowing to specific kids.
function KidTags({ contact, kids }) {
  if (!kids || kids.length <= 1) return null;
  const tagged = (contact.childIds || []).map((id) => kids.find((k) => k.id === id)).filter(Boolean);
  if (tagged.length === 0) return null;
  return (
    <div className="flex -space-x-1.5 shrink-0">
      {tagged.map((k) => (
        <div key={k.id} className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
          style={{ backgroundColor: "#4A7FAE", color: "white", border: "1.5px solid white" }}>
          {k.initials}
        </div>
      ))}
    </div>
  );
}

function AddContactForm({ onAdd, onCancel, defaultCategory, kids }) {
  const category = defaultCategory; // locked — you already chose the category by drilling into it
  const meta = INFO_CATEGORY_META[category];
  const [name, setName] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [childIds, setChildIds] = useState([]);
  const canSubmit = name.trim().length > 0;
  const showKidTags = kids && kids.length > 1;

  const toggleKid = (id) => setChildIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
      <div className="flex items-center gap-2 mb-3">
        <meta.icon size={15} color={meta.color} />
        <span className="text-[12px] font-semibold" style={{ color: meta.color }}>Adding to {meta.label}</span>
      </div>
      <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      <input placeholder="What they are (e.g. Speech therapist, 3rd grade teacher)" value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      <input type="tel" placeholder="(555) 123-4567" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      <input placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      <input type="url" placeholder="Link (portal, shared doc, IEP file, etc.)" value={url} onChange={(e) => setUrl(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      <input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />

      {showKidTags && (
        <div className="mb-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Who is this for?</p>
          <div className="flex gap-1.5 flex-wrap">
            {kids.map((k) => {
              const active = childIds.includes(k.id);
              return (
                <button key={k.id} type="button" onClick={() => toggleKid(k.id)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                  style={{ WebkitAppearance: "none", backgroundColor: active ? "#4A7FAE" : "#F2F7FB", color: active ? "white" : "#4A7FAE" }}>
                  {k.name}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[#B7C3CC] mt-1.5">Leave everyone unselected if this contact applies to the whole household.</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => canSubmit && onAdd({ category, name: name.trim(), subtitle: subtitle.trim(), phone: phone.trim(), address: address.trim(), url: url.trim(), notes: notes.trim(), childIds })}
          disabled={!canSubmit}
          className="flex-1 rounded-xl py-2.5 font-semibold text-[14px]"
          style={{ backgroundColor: canSubmit ? "#4A7FAE" : "#C4CDD6", color: "white", WebkitAppearance: "none" }}
        >
          Save contact
        </button>
        <button onClick={onCancel} className="rounded-xl py-2.5 px-4 font-semibold text-[14px]" style={{ backgroundColor: "#F2F7FB", color: "#8A94A0", WebkitAppearance: "none" }}>Cancel</button>
      </div>
    </div>
  );
}

function ContactDetailModal({ contact, canWrite, onClose, onSave, onDelete, kids }) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(contact.category);
  const [name, setName] = useState(contact.name);
  const [subtitle, setSubtitle] = useState(contact.subtitle || "");
  const [phone, setPhone] = useState(contact.phone || "");
  const [address, setAddress] = useState(contact.address || "");
  const [url, setUrl] = useState(contact.url || "");
  const [notes, setNotes] = useState(contact.notes || "");
  const [childIds, setChildIds] = useState(contact.childIds || []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = INFO_CATEGORY_META[category] || INFO_CATEGORY_META.other;
  const Icon = meta.icon;
  const canSave = name.trim().length > 0;
  const showKidTags = kids && kids.length > 1;
  const toggleKid = (id) => setChildIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const taggedKids = showKidTags ? (contact.childIds || []).map((id) => kids.find((k) => k.id === id)).filter(Boolean) : [];

  return (
    <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 50 }} onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[19px] text-[#3A4048]">{editing ? "Edit contact" : "Contact"}</h2>
          <button onClick={onClose} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
        </div>

        {!editing ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                <Icon size={20} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[17px] text-[#3A4048] font-semibold truncate">{contact.name}</p>
                <p className="text-[13px] text-[#8A94A0] truncate">{contact.subtitle}</p>
              </div>
            </div>

            <div className="rounded-2xl overflow-hidden mb-6" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Category</span>
                <span className="text-[13px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
              </div>
              {showKidTags && (
                <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                  <span className="text-[12px] text-[#8A94A0]">Who it's for</span>
                  <span className="text-[13px] font-semibold text-[#3A4048]">
                    {taggedKids.length > 0 ? taggedKids.map((k) => k.name).join(", ") : "Whole household"}
                  </span>
                </div>
              )}
              {contact.phone && (
                <a href={`tel:${(contact.phone || "").replace(/\D/g, "")}`} className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: (contact.address || contact.notes) ? "1px solid #EEF3F7" : "none", textDecoration: "none" }}>
                  <span className="text-[12px] text-[#8A94A0]">Phone</span>
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: "#4A7FAE" }}><Phone size={13} /> {contact.phone}</span>
                </a>
              )}
              {contact.address && (
                <a href={`https://maps.apple.com/?q=${encodeURIComponent(contact.address)}`} target="_blank" rel="noreferrer" className="flex items-center justify-between px-4 py-2.5 gap-3" style={{ borderBottom: (contact.url || contact.notes) ? "1px solid #EEF3F7" : "none", textDecoration: "none" }}>
                  <span className="text-[12px] text-[#8A94A0] shrink-0">Address</span>
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-right" style={{ color: "#4A7FAE" }}><MapPin size={13} className="shrink-0" /> {contact.address}</span>
                </a>
              )}
              {contact.url && (
                <a href={/^https?:\/\//.test(contact.url) ? contact.url : `https://${contact.url}`} target="_blank" rel="noreferrer" className="flex items-center justify-between px-4 py-2.5 gap-3" style={{ borderBottom: contact.notes ? "1px solid #EEF3F7" : "none", textDecoration: "none" }}>
                  <span className="text-[12px] text-[#8A94A0] shrink-0">Link</span>
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-right truncate" style={{ color: "#4A7FAE" }}><LinkIcon size={13} className="shrink-0" /> <span className="truncate">{contact.url}</span></span>
                </a>
              )}
              {contact.notes && (
                <div className="px-4 py-2.5">
                  <span className="text-[12px] text-[#8A94A0] block mb-1">Notes</span>
                  <span className="text-[13px] text-[#3A4048]">{contact.notes}</span>
                </div>
              )}
            </div>

            {canWrite ? (
              !confirmDelete ? (
                <div className="flex gap-2">
                  <button onClick={() => setEditing(true)} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>Edit</button>
                  <button onClick={() => setConfirmDelete(true)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>Delete</button>
                </div>
              ) : (
                <div className="rounded-2xl p-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                  <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Delete this contact? This can't be undone.</p>
                  <div className="flex gap-2">
                    <button onClick={onDelete} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Delete</button>
                    <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                  </div>
                </div>
              )
            ) : (
              <p className="text-[12px] text-[#B7C3CC] text-center">View-only access — ask an owner or full-access caregiver to make changes.</p>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
              <div className="flex gap-1.5 flex-wrap">
                {Object.entries(INFO_CATEGORY_META).map(([key, m]) => (
                  <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: category === key ? m.color : "#F2F7FB", color: category === key ? "white" : m.color }}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Name</p>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">What they are</p>
              <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Phone</p>
              <input type="tel" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Address</p>
              <input value={address} onChange={(e) => setAddress(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Link</p>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Portal, shared doc, IEP file, etc."
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Notes</p>
              <input value={notes} onChange={(e) => setNotes(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            {showKidTags && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Who is this for?</p>
                <div className="flex gap-1.5 flex-wrap">
                  {kids.map((k) => {
                    const active = childIds.includes(k.id);
                    return (
                      <button key={k.id} type="button" onClick={() => toggleKid(k.id)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                        style={{ WebkitAppearance: "none", backgroundColor: active ? "#4A7FAE" : "#F2F7FB", color: active ? "white" : "#4A7FAE" }}>
                        {k.name}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-[#B7C3CC] mt-1.5">Leave everyone unselected for the whole household.</p>
              </div>
            )}
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => canSave && onSave({ category, name: name.trim(), subtitle: subtitle.trim(), phone: phone.trim(), address: address.trim(), url: url.trim(), notes: notes.trim(), childIds })}
                disabled={!canSave}
                className="flex-1 rounded-2xl py-3 font-semibold text-[14px]"
                style={{ WebkitAppearance: "none", backgroundColor: canSave ? "#4A7FAE" : "#C4CDD6", color: "white" }}
              >
                Save
              </button>
              <button onClick={() => setEditing(false)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HouseholdScreen({ household, persistHousehold, addChild, editChild, deleteChild, myRole, households, activeHouseholdId, switchHousehold, addHousehold, deleteHousehold }) {
  const [section, setSection] = useState("main"); // "main" | "manage-households"
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRelation, setInviteRelation] = useState("");
  const [inviteRole, setInviteRole] = useState("view");
  const [childOpen, setChildOpen] = useState(false);
  const [childName, setChildName] = useState("");
  const [childAge, setChildAge] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(household.name || "");
  const [addHouseholdOpen, setAddHouseholdOpen] = useState(false);
  const [confirmDeleteHouseholdId, setConfirmDeleteHouseholdId] = useState(null);
  const [newHouseholdName, setNewHouseholdName] = useState("");
  const [editingMember, setEditingMember] = useState(null); // member object being role-edited
  const [selectedChild, setSelectedChild] = useState(null);
  const [confirmRemoveMember, setConfirmRemoveMember] = useState(false);
  const [memberNoteDraft, setMemberNoteDraft] = useState("");
  useEffect(() => { setMemberNoteDraft(editingMember?.note || ""); }, [editingMember?.id]);
  const isOwner = myRole === "owner";
  const canWrite = myRole !== "view";

  useEffect(() => { setNameDraft(household.name || ""); setEditingName(false); setChildOpen(false); setInviteOpen(false); }, [household.id]);

  const submitChild = async () => {
    if (!childName.trim()) return;
    await addChild(childName, childAge);
    setChildName(""); setChildAge(""); setChildOpen(false);
  };

  const saveName = async () => {
    if (!nameDraft.trim()) { setEditingName(false); return; }
    await persistHousehold({ ...household, name: nameDraft.trim() });
    setEditingName(false);
  };

  const submitNewHousehold = async () => {
    if (!newHouseholdName.trim()) return;
    await addHousehold(newHouseholdName);
    setNewHouseholdName(""); setAddHouseholdOpen(false);
  };

  const changeRole = async (memberId, role) => {
    const next = { ...household, members: household.members.map((m) => (m.id === memberId ? { ...m, role } : m)) };
    await persistHousehold(next);
    setEditingMember(null);
    setConfirmRemoveMember(false);
  };

  const saveMemberNote = async (memberId, note) => {
    const next = { ...household, members: household.members.map((m) => (m.id === memberId ? { ...m, note } : m)) };
    await persistHousehold(next);
  };

  const ownerCount = household.members.filter((m) => m.role === "owner").length;

  const removeMember = async (memberId) => {
    const next = { ...household, members: household.members.filter((m) => m.id !== memberId) };
    await persistHousehold(next);
    setEditingMember(null);
    setConfirmRemoveMember(false);
  };

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return;
    const next = { ...household, invites: [...household.invites, { id: uid(), email: inviteEmail.trim(), relation: inviteRelation.trim() || "Caregiver", role: inviteRole }] };
    await persistHousehold(next);
    setInviteEmail(""); setInviteRelation(""); setInviteRole("view"); setInviteOpen(false);
  };

  const acceptInvite = async (inviteId) => {
    const inv = household.invites.find((i) => i.id === inviteId);
    if (!inv) return;
    const name = inv.email.split("@")[0];
    try {
      // The RPC itself enforces that the invite's email matches the signed-in account —
      // it's the actual security boundary, not just a client-side convenience check.
      const newMember = await acceptInviteRpc(inviteId, name, name[0]?.toUpperCase() || "?");
      const next = {
        ...household,
        members: [...household.members, newMember],
        invites: household.invites.filter((i) => i.id !== inviteId),
      };
      await persistHousehold(next);
    } catch (e) {
      console.error("acceptInvite failed", e);
      alert(e.message || "Couldn't accept that invite. Make sure you're signed in with the email it was sent to.");
    }
  };

  if (section === "manage-households") {
    return (
      <div>
        <div className="px-6 pt-8 pb-4 flex items-center gap-3">
          <button onClick={() => setSection("main")} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><ChevronLeft size={20} color="#4A7FAE" /></button>
          <h1 className="font-display text-[20px] text-[#3A4048]">Manage households</h1>
        </div>

        {households.length > 1 && (
          <div className="mx-5 rounded-3xl overflow-hidden mb-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            {households.map((h, i) => (
              <div key={h.id}>
                <div className="w-full flex items-center gap-3 px-4 py-3" style={{ borderBottom: (i < households.length - 1 || confirmDeleteHouseholdId === h.id) ? "1px solid #EEF3F7" : "none" }}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] text-[#3A4048] font-semibold truncate">{h.name}</p>
                    <p className="text-[12px] text-[#8A94A0]">{h.children.length} {h.children.length === 1 ? "child" : "children"}{h.id === activeHouseholdId ? " · Currently viewing" : ""}</p>
                  </div>
                  {h.id !== activeHouseholdId && (
                    <button onClick={() => switchHousehold(h.id)} className="text-[12px] font-semibold text-[#4A7FAE] shrink-0" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>Switch</button>
                  )}
                  {canWrite && (
                    <button onClick={() => setConfirmDeleteHouseholdId(h.id)} className="shrink-0" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }} aria-label={`Delete ${h.name}`}>
                      <X size={16} color="#C67B6C" />
                    </button>
                  )}
                </div>
                {confirmDeleteHouseholdId === h.id && (
                  <div className="px-4 py-3" style={{ backgroundColor: "#FBF1EF", borderBottom: i < households.length - 1 ? "1px solid #EEF3F7" : "none" }}>
                    <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">
                      Delete "{h.name}"? This removes all its children, their care schedules, timeline history, and Info Bank. This can't be undone.
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => { deleteHousehold(h.id); setConfirmDeleteHouseholdId(null); }} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Delete</button>
                      <button onClick={() => setConfirmDeleteHouseholdId(null)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!addHouseholdOpen ? (
          <div className="mx-5">
            <button onClick={() => setAddHouseholdOpen(true)} className="w-full box-border rounded-2xl border-2 border-dashed py-3 flex items-center justify-center gap-2"
              style={{ backgroundColor: "#F7F9FB", borderColor: "#4A7FAE", WebkitAppearance: "none" }}>
              <Plus size={15} color="#4A7FAE" /><span className="text-[13px] font-semibold text-[#4A7FAE]">Add another household</span>
            </button>
          </div>
        ) : (
          <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            <input placeholder="Household name (e.g. Grandma's House)" value={newHouseholdName} onChange={(e) => setNewHouseholdName(e.target.value)}
              className="w-full text-[14px] px-3 py-2 rounded-xl mb-3 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            <div className="flex gap-2">
              <button onClick={submitNewHousehold} className="flex-1 rounded-xl py-2.5 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>Create</button>
              <button onClick={() => setAddHouseholdOpen(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[14px]" style={{ backgroundColor: "#F2F7FB", color: "#8A94A0", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )}
        <p className="mx-5 mt-2 text-[11px] text-[#B7C3CC] leading-relaxed">
          Separate households keep their own children, members, schedules, and timeline — useful for a co-parent's home, a grandparent's, or anywhere else your kid splits time.
        </p>
      </div>
    );
  }

  return (
    <div>
      {households.length > 1 && (
        <div className="px-5 pt-6 flex gap-2 overflow-x-auto">
          {households.map((h) => {
            const active = h.id === activeHouseholdId;
            return (
              <button key={h.id} onClick={() => switchHousehold(h.id)} className="px-3.5 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap shrink-0"
                style={{ backgroundColor: active ? "#4A7FAE" : "white", color: active ? "white" : "#4A7FAE", border: active ? "none" : "1px solid #DCEAF5", WebkitAppearance: "none" }}>
                {h.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="px-6 pt-6 pb-4">
        <p className="text-[13px] tracking-wide text-[#8A94A0] uppercase font-semibold">Household</p>
        {!editingName ? (
          <button onClick={() => canWrite && setEditingName(true)} className="flex items-center gap-2 mt-1" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
            <h1 className="font-display text-[26px] text-[#3A4048]">{household.name || "My Household"}</h1>
          </button>
        ) : (
          <div className="flex items-center gap-2 mt-1">
            <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
              className="font-display text-[22px] text-[#3A4048] outline-none bg-transparent flex-1" style={{ borderBottom: "2px solid #4A7FAE", WebkitAppearance: "none" }} />
            <button onClick={saveName} className="text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>Save</button>
          </div>
        )}
        {canWrite && !editingName && <p className="text-[11px] text-[#B7C3CC] mt-0.5">Tap the name to rename this household</p>}
      </div>

      <div className="px-6 mb-2"><p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">Children</p></div>
      <div className="mx-5 rounded-3xl overflow-hidden mb-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {household.children.length === 0 && (
          <div className="px-5 py-6 text-center"><p className="text-[13px] text-[#8A94A0]">No children in this household yet.</p></div>
        )}
        {household.children.map((c, i) => (
          <button key={c.id} onClick={() => setSelectedChild(c)} className="w-full flex items-center gap-3 px-4 py-3 text-left" style={{ borderBottom: "1px solid #EEF3F7", backgroundColor: "white", WebkitAppearance: "none" }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0" style={{ backgroundColor: "rgba(74,127,174,0.15)", color: "#4A7FAE" }}>{c.initials}</div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-[14px] text-[#3A4048] font-semibold">{c.name}</p>
              <p className="text-[12px] text-[#8A94A0] truncate">Age {c.age}{c.bio ? ` · ${c.bio}` : ""}</p>
            </div>
            <ChevRight size={14} color="#C4CDD6" className="shrink-0" />
          </button>
        ))}
      </div>

      {canWrite ? (
        !childOpen ? (
          <div className="mx-5 mb-6">
            <button onClick={() => setChildOpen(true)} className="w-full box-border block" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
              <div className="w-full box-border rounded-2xl border-2 border-dashed py-3 px-4 flex items-center justify-center gap-2" style={{ backgroundColor: "#F7F9FB", borderColor: "#4A7FAE" }}>
                <Plus size={15} color="#4A7FAE" className="shrink-0" /><span className="text-[13px] font-semibold text-[#4A7FAE] leading-none">Add a child</span>
              </div>
            </button>
          </div>
        ) : (
          <div className="mx-5 rounded-2xl p-4 mb-6" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            <input placeholder="Name" value={childName} onChange={(e) => setChildName(e.target.value)}
              className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            <input placeholder="Age" type="number" min="0" value={childAge} onChange={(e) => setChildAge(e.target.value)}
              className="w-full text-[14px] px-3 py-2 rounded-xl mb-3 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            <div className="flex gap-2">
              <button onClick={submitChild} className="flex-1 rounded-xl py-2.5 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>Add child</button>
              <button onClick={() => setChildOpen(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[14px]" style={{ backgroundColor: "#F2F7FB", color: "#8A94A0", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )
      ) : (
        <p className="mx-5 mb-6 text-[12px] text-[#B7C3CC]">View-only access — ask an owner or full-access caregiver to add a child.</p>
      )}

      <div className="px-6 mb-2"><p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">People with access</p></div>
      <div className="mx-5 rounded-3xl overflow-hidden mb-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {household.members.map((m, i) => {
          const role = ROLE_META[m.role];
          const RoleIcon = role.icon;
          const Row = isOwner ? "button" : "div";
          return (
            <Row key={m.id} onClick={isOwner ? () => { setEditingMember(m); setConfirmRemoveMember(false); } : undefined} className="w-full flex items-center gap-3 px-4 py-3 text-left"
              style={{ borderBottom: i < household.members.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0" style={{ backgroundColor: "#F2F7FB", color: "#4A7FAE" }}>{m.initials}</div>
              <div className="min-w-0 flex-1"><p className="text-[14px] text-[#3A4048] font-semibold truncate">{m.name}</p><p className="text-[12px] text-[#8A94A0] truncate">{m.relation}{m.note ? ` · ${m.note}` : ""}</p></div>
              <div className="flex items-center gap-1 shrink-0"><RoleIcon size={13} color={role.color} /><span className="text-[12px] font-semibold" style={{ color: role.color }}>{role.label}</span></div>
              {isOwner && <ChevRight size={14} color="#C4CDD6" className="shrink-0" />}
            </Row>
          );
        })}
      </div>
      {isOwner && <p className="mx-5 mb-3 text-[11px] text-[#B7C3CC]">Tap anyone to change their permissions.</p>}

      {household.invites.length > 0 && (
        <>
          <div className="px-6 mb-2"><p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">Pending</p></div>
          <div className="mx-5 rounded-3xl overflow-hidden mb-6" style={{ backgroundColor: "white", border: "1px dashed #C9D8E6" }}>
            {household.invites.map((p, i, arr) => {
              const Row = canWrite ? "button" : "div";
              return (
                <Row key={p.id} onClick={canWrite ? () => acceptInvite(p.id) : undefined} className="w-full flex items-center gap-3 px-4 py-3" style={{ borderBottom: i < arr.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "#F2F7FB" }}><Mail size={15} color="#8A94A0" /></div>
                  <div className="min-w-0 flex-1 text-left"><p className="text-[14px] text-[#3A4048] font-semibold truncate">{p.email}</p><p className="text-[12px] text-[#8A94A0] truncate">Invited as {p.relation} · {ROLE_META[p.role || "view"].label}{canWrite ? " · tap to mark accepted" : ""}</p></div>
                </Row>
              );
            })}
          </div>
        </>
      )}

      {canWrite ? (
        !inviteOpen ? (
          <div className="mx-5">
            <button onClick={() => setInviteOpen(true)} className="w-full box-border block" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
              <div className="w-full box-border rounded-2xl border-2 border-dashed py-3.5 px-4 flex items-center justify-center gap-2" style={{ backgroundColor: "#F7F9FB", borderColor: "#4A7FAE" }}>
                <Plus size={16} color="#4A7FAE" className="shrink-0" /><span className="text-[14px] font-semibold text-[#4A7FAE] leading-none">Invite someone</span>
              </div>
            </button>
          </div>
        ) : (
          <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            <input placeholder="Email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
              className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            <input placeholder="Relation (e.g. Aunt, Therapist)" value={inviteRelation} onChange={(e) => setInviteRelation(e.target.value)}
              className="w-full text-[14px] px-3 py-2 rounded-xl mb-3 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Permission level</p>
            <div className="flex flex-col gap-2 mb-3">
              {["owner", "full", "view"].map((r) => {
                const meta = ROLE_META[r];
                const RIcon = meta.icon;
                const active = inviteRole === r;
                return (
                  <button key={r} onClick={() => setInviteRole(r)} className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left"
                    style={{ backgroundColor: active ? "rgba(74,127,174,0.08)" : "white", border: `1.5px solid ${active ? "#4A7FAE" : "#DCEAF5"}`, WebkitAppearance: "none" }}>
                    <RIcon size={15} color={meta.color} className="mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-[#3A4048]">{meta.label}</p>
                      <p className="text-[11px] text-[#8A94A0] leading-snug mt-0.5">{meta.description}</p>
                    </div>
                    {active && <Check size={15} color="#4A7FAE" className="shrink-0 mt-0.5" />}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button onClick={sendInvite} className="flex-1 rounded-xl py-2.5 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>Send invite</button>
              <button onClick={() => { setInviteOpen(false); setInviteEmail(""); setInviteRelation(""); setInviteRole("view"); }} className="rounded-xl py-2.5 px-4 font-semibold text-[14px]" style={{ backgroundColor: "#F2F7FB", color: "#8A94A0", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )
      ) : (
        <p className="mx-5 text-[12px] text-[#B7C3CC]">View-only access — ask an owner to invite someone.</p>
      )}

      <div className="px-6 mb-2 mt-6"><p className="text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0]">Households</p></div>
      <div className="mx-5">
        <button onClick={() => setSection("manage-households")} className="w-full box-border block" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
          <div className="w-full box-border rounded-2xl px-4 py-3 flex items-center gap-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            <Home size={16} color="#4A7FAE" />
            <span className="text-[14px] font-semibold text-[#3A4048] flex-1 text-left">Manage households</span>
            {households.length > 1 && <span className="text-[12px] text-[#8A94A0]">{households.length}</span>}
            <ChevRight size={14} color="#C4CDD6" />
          </div>
        </button>
      </div>

      {editingMember && (
        <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 50 }} onClick={() => { setEditingMember(null); setConfirmRemoveMember(false); }}>
          <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-[19px] text-[#3A4048]">Edit permissions</h2>
              <button onClick={() => { setEditingMember(null); setConfirmRemoveMember(false); }} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
            </div>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-11 h-11 rounded-full flex items-center justify-center text-[14px] font-bold shrink-0" style={{ backgroundColor: "#F2F7FB", color: "#4A7FAE" }}>{editingMember.initials}</div>
              <div className="min-w-0 flex-1"><p className="text-[16px] text-[#3A4048] font-semibold truncate">{editingMember.name}</p><p className="text-[13px] text-[#8A94A0] truncate">{editingMember.relation}</p></div>
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-2">Permission level</p>
            <div className="flex flex-col gap-2">
              {["owner", "full", "view"].map((r) => {
                const meta = ROLE_META[r];
                const RIcon = meta.icon;
                const active = editingMember.role === r;
                return (
                  <button key={r} onClick={() => changeRole(editingMember.id, r)} className="w-full flex items-start gap-3 px-4 py-3 rounded-2xl text-left"
                    style={{ backgroundColor: active ? "rgba(74,127,174,0.08)" : "white", border: `1.5px solid ${active ? "#4A7FAE" : "#DCEAF5"}`, WebkitAppearance: "none" }}>
                    <RIcon size={16} color={meta.color} className="mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-semibold text-[#3A4048]">{meta.label}</p>
                      <p className="text-[11px] text-[#8A94A0] leading-snug mt-0.5">{meta.description}</p>
                    </div>
                    {active && <Check size={16} color="#4A7FAE" className="shrink-0 mt-0.5" />}
                  </button>
                );
              })}
            </div>
            {editingMember.isYou && (
              <p className="text-[11px] text-[#B7C3CC] mt-3 leading-relaxed">
                That's you — changing this changes your own access immediately, same as the role tester in Settings.
              </p>
            )}

            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Note</p>
              <textarea value={memberNoteDraft} onChange={(e) => setMemberNoteDraft(e.target.value)} rows={3}
                placeholder="e.g. Available weekends only, primary weekday caregiver, lives nearby for emergencies"
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048] resize-none" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none", fontFamily: "inherit" }} />
              <button onClick={() => saveMemberNote(editingMember.id, memberNoteDraft.trim())} className="mt-2 text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                Save note
              </button>
            </div>

            {!editingMember.isYou && (
              !confirmRemoveMember ? (
                <button onClick={() => setConfirmRemoveMember(true)} className="w-full mt-4 rounded-2xl py-3 font-semibold text-[14px]"
                  style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>
                  Remove from household
                </button>
              ) : (
                <div className="rounded-2xl p-4 mt-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                  <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Remove {editingMember.name} from this household? They'll lose all access.</p>
                  <div className="flex gap-2">
                    <button onClick={() => removeMember(editingMember.id)} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Remove</button>
                    <button onClick={() => setConfirmRemoveMember(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {selectedChild && (
        <ChildEditModal
          child={selectedChild}
          myRole={myRole}
          canDelete={household.children.length > 1}
          onClose={() => setSelectedChild(null)}
          onSave={(patch) => { editChild(selectedChild.id, patch); setSelectedChild(null); }}
          onDelete={() => { deleteChild(selectedChild.id); setSelectedChild(null); }}
        />
      )}
    </div>
  );
}

function ChildEditModal({ child, myRole, canDelete, onClose, onSave, onDelete }) {
  const [name, setName] = useState(child.name);
  const [age, setAge] = useState(String(child.age));
  const [bio, setBio] = useState(child.bio || "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canWrite = myRole !== "view";
  const canSave = name.trim().length > 0;

  return (
    <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 55 }} onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[19px] text-[#3A4048]">Edit child</h2>
          <button onClick={onClose} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
        </div>

        {!canWrite ? (
          <p className="text-[12px] text-[#B7C3CC] text-center py-6">View-only access — ask an owner or full-access caregiver to make changes.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Name</p>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Age</p>
              <input type="number" min="0" value={age} onChange={(e) => setAge(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">About {name.trim() || "them"}</p>
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={5}
                placeholder="Anything a caregiver should know — diagnoses, support needs, communication style, likes and dislikes, sensory triggers, whatever's actually useful in the moment."
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048] resize-none" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none", fontFamily: "inherit" }} />
              <p className="text-[11px] text-[#B7C3CC] mt-1.5 leading-relaxed">
                Visible to everyone with access to this household — including view-only caregivers, since this is exactly the context they'd need.
              </p>
            </div>

            {!confirmDelete ? (
              <div className="flex gap-2 mt-1">
                <button onClick={() => canSave && onSave({ name, age, bio })} disabled={!canSave} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]"
                  style={{ WebkitAppearance: "none", backgroundColor: canSave ? "#4A7FAE" : "#C4CDD6", color: "white" }}>Save</button>
                {canDelete && (
                  <button onClick={() => setConfirmDelete(true)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>Remove</button>
                )}
              </div>
            ) : (
              <div className="rounded-2xl p-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">
                  Remove {child.name} from this household? This deletes their care schedule, timeline history, and upcoming events. This can't be undone.
                </p>
                <div className="flex gap-2">
                  <button onClick={onDelete} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Remove</button>
                  <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                </div>
              </div>
            )}
            {!canDelete && (
              <p className="text-[11px] text-[#B7C3CC] leading-relaxed">
                This is the only child in the household, so they can't be removed — delete the whole household instead if needed.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick log modal
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Small Hours/Minutes pill switcher, shared by every place a caregiver enters a timing
// interval — so "every 10 minutes" or "every 30 minutes" is possible, not just whole hours.
function UnitToggle({ unit, setUnit }) {
  return (
    <div className="flex rounded-lg overflow-hidden shrink-0" style={{ border: "1px solid #DCEAF5" }}>
      <button type="button" onClick={() => setUnit("hours")} className="px-2 py-1 text-[12px] font-semibold"
        style={{ WebkitAppearance: "none", backgroundColor: unit === "hours" ? "#4A7FAE" : "white", color: unit === "hours" ? "white" : "#4A7FAE" }}>
        hrs
      </button>
      <button type="button" onClick={() => setUnit("minutes")} className="px-2 py-1 text-[12px] font-semibold"
        style={{ WebkitAppearance: "none", backgroundColor: unit === "minutes" ? "#4A7FAE" : "white", color: unit === "minutes" ? "white" : "#4A7FAE" }}>
        min
      </button>
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} className="w-11 h-6 rounded-full flex items-center px-0.5 shrink-0" style={{ backgroundColor: on ? "#4A7FAE" : "#DCE3E9", WebkitAppearance: "none", transition: "background-color 150ms" }}>
      <div className="w-5 h-5 rounded-full bg-white shadow" style={{ transform: on ? "translateX(20px)" : "translateX(0)", transition: "transform 150ms" }} />
    </button>
  );
}

function SettingsScreen({ settings, persistSettings, onLogout, onDeleteAllData, onSimulateReopen, household, persistHousehold, myRole, infoBank, persistInfoBank, households, activeHouseholdId, switchHousehold, notifPermission, requestNotifications, speakText }) {
  const [section, setSection] = useState(null); // null | 'profile' | 'notifications' | 'security' | 'privacy' | 'help' | 'infobank'
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rows = [
    { key: "profile", label: "Profile", icon: User },
    { key: "plan", label: "Plan", icon: Sparkles },
    { key: "colors", label: "Category Colors", icon: Palette },
    { key: "accessibility", label: "Accessibility", icon: Volume2 },
    { key: "infobank", label: "Info Bank", icon: BookOpen },
    { key: "notifications", label: "Notifications", icon: Bell },
    { key: "security", label: "Security", icon: ShieldCheck },
    { key: "privacy", label: "Privacy & Data", icon: Lock },
    { key: "help", label: "Help Center", icon: HelpCircle },
  ];

  const updateProfile = (patch) => persistSettings({ ...settings, profile: { ...settings.profile, ...patch } });

  if (section === "plan") {
    return <PlanScreen onBack={() => setSection(null)} />;
  }

  if (section === "colors") {
    return <CategoryColorsScreen settings={settings} persistSettings={persistSettings} onBack={() => setSection(null)} speakText={speakText} />;
  }

  if (section === "accessibility") {
    return <AccessibilityScreen settings={settings} persistSettings={persistSettings} onBack={() => setSection(null)} />;
  }

  if (section === "infobank") {
    return <InfoBankScreen infoBank={infoBank} persistInfoBank={persistInfoBank} myRole={myRole} onBack={() => setSection(null)}
      households={households} activeHouseholdId={activeHouseholdId} switchHousehold={switchHousehold} kids={household.children} />;
  }

  if (section === "profile") {
    const p = settings.profile || {};
    return (
      <SettingsSubpage title="My Profile" onBack={() => setSection(null)}>
        <SettingsSectionLabel>Account Information</SettingsSectionLabel>
        <EditableField label="First Name" value={p.firstName} placeholder="Add name" onSave={(v) => updateProfile({ firstName: v })} />
        <EditableField label="Last Name" value={p.lastName} placeholder="Add name" onSave={(v) => updateProfile({ lastName: v })} last />
        <SettingsSectionLabel>Contact Information</SettingsSectionLabel>
        <EditableField label="Email" value={p.email} placeholder="Add email" type="email" onSave={(v) => updateProfile({ email: v })} />
        <EditableField label="Phone" value={p.phone} placeholder="(555) 123-4567" type="tel" onSave={(v) => updateProfile({ phone: v })} format={formatPhoneInput} last />
      </SettingsSubpage>
    );
  }

  if (section === "notifications") {
    const channel = settings.notifyChannel || "email";
    return (
      <SettingsSubpage title="Notifications" onBack={() => setSection(null)} noCard>
        <div className="mx-5 mb-4 rounded-full flex p-1" style={{ backgroundColor: "#F2F7FB" }}>
          <button onClick={() => persistSettings({ ...settings, notifyChannel: "email" })} className="flex-1 py-2 rounded-full text-[13px] font-semibold"
            style={{ WebkitAppearance: "none", backgroundColor: channel === "email" ? "white" : "transparent", color: channel === "email" ? "#3A4048" : "#8A94A0", boxShadow: channel === "email" ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}>
            Email & SMS
          </button>
          <button onClick={() => persistSettings({ ...settings, notifyChannel: "push" })} className="flex-1 py-2 rounded-full text-[13px] font-semibold"
            style={{ WebkitAppearance: "none", backgroundColor: channel === "push" ? "white" : "transparent", color: channel === "push" ? "#3A4048" : "#8A94A0", boxShadow: channel === "push" ? "0 1px 3px rgba(0,0,0,0.08)" : "none" }}>
            Push
          </button>
        </div>

        {channel === "email" ? (
          <div className="mx-5 rounded-3xl overflow-hidden" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
            <SettingsToggleRow label="Medication & care reminders" desc="Alerts when something is due or available" on={settings.notifyMeds}
              onClick={() => persistSettings({ ...settings, notifyMeds: !settings.notifyMeds })} />
            <SettingsToggleRow label="Upcoming events" desc="Appointments, school, therapy sessions" on={settings.notifyEvents}
              onClick={() => persistSettings({ ...settings, notifyEvents: !settings.notifyEvents })} last />
            <p className="px-4 pb-3 pt-1 text-[11px] text-[#B7C3CC] leading-relaxed">
              Email and SMS delivery connect to a production backend at launch. These toggles already drive the live browser
              notifications below, using the same due-date logic that will power every delivery channel.
            </p>
          </div>
        ) : notifPermission === "unsupported" ? (
          <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "#EEF4F9" }}>
            <p className="text-[13px] text-[#3A6E96] leading-relaxed">This browser doesn't support notifications.</p>
          </div>
        ) : notifPermission === "granted" ? (
          <div className="mx-5 rounded-2xl p-4 flex items-center gap-3" style={{ backgroundColor: "rgba(95,166,99,0.1)", border: "1px solid rgba(95,166,99,0.3)" }}>
            <BellRing size={18} color="#5FA663" className="shrink-0" />
            <p className="text-[13px] text-[#3E7A43] leading-relaxed">
              Notifications are on. You'll get a real alert the moment something becomes due — the same logic and timing
              that carries over to push notifications once this runs on a full backend.
            </p>
          </div>
        ) : (
          <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "#EEF4F9" }}>
            <p className="text-[13px] text-[#3A6E96] leading-relaxed mb-3">
              Turn these on to see it in action — a real alert fires the instant something becomes due, using the exact
              escalation logic (getting close, almost due, due now) that ships to true background push in production.
            </p>
            <button onClick={requestNotifications} className="w-full rounded-2xl py-3 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>
              {notifPermission === "denied" ? "Blocked — enable in browser settings" : "Enable notifications"}
            </button>
          </div>
        )}
      </SettingsSubpage>
    );
  }

  if (section === "privacy") {
    return (
      <SettingsSubpage title="Privacy & Data" onBack={() => { setSection(null); setConfirmDelete(false); }} noCard>
        <div className="mx-5 rounded-2xl p-4 mb-3" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
          <p className="text-[13px] font-semibold text-[#3A4048] mb-1">What's stored, and where</p>
          <p className="text-[12.5px] text-[#6B7480] leading-relaxed">
            Everything you enter — schedules, notes, household members — is saved so it's there next time you open the app.
            This is an early preview build and has not yet been through a formal security or privacy review. Please avoid
            entering real sensitive details about your child until that review is complete.
          </p>
        </div>

        <div className="mx-5 rounded-3xl overflow-hidden mb-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
          <div className="px-4 py-3.5">
            <p className="text-[14px] text-[#3A4048] font-medium mb-1">Delete all my data</p>
            <p className="text-[12px] text-[#8A94A0] leading-relaxed">Permanently removes everything — household, children, schedules, and settings. This can't be undone.</p>
          </div>
        </div>

        {!confirmDelete ? (
          <div className="mx-5">
            <button onClick={() => setConfirmDelete(true)} className="w-full box-border flex items-center justify-center gap-2 rounded-2xl py-3.5"
              style={{ backgroundColor: "white", border: "1px solid #F0D9D5", color: "#C67B6C", WebkitAppearance: "none" }}>
              <span className="text-[14px] font-semibold">Delete all my data</span>
            </button>
          </div>
        ) : (
          <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
            <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Are you sure? This permanently deletes everything and can't be undone.</p>
            <div className="flex gap-2">
              <button onClick={onDeleteAllData} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Yes, delete everything</button>
              <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
            </div>
          </div>
        )}
      </SettingsSubpage>
    );
  }

  if (section === "help") {
    return (
      <SettingsSubpage title="Help Center" onBack={() => setSection(null)} noCard>
        <div className="mx-5 rounded-2xl p-4 mb-3" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
          <p className="text-[13px] font-semibold text-[#3A4048] mb-1">About the timers on Today</p>
          <p className="text-[12.5px] text-[#6B7480] leading-relaxed">
            Every schedule in this app — medication, meals, sensory breaks, anything — comes from what you or another caregiver typed in.
            Nothing is looked up, suggested, or filled in automatically. This app is a personal organizer, not a medical device or a
            source of medical advice.
          </p>
        </div>
        <div className="mx-5 rounded-2xl p-4 mb-3" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
          <p className="text-[13px] font-semibold text-[#3A4048] mb-1">Medication timing</p>
          <p className="text-[12.5px] text-[#6B7480] leading-relaxed">
            Always follow the instructions given by your child's doctor or pharmacist, or printed on the medication label — not what's
            shown here. If you're ever unsure about a dose or timing, contact your pharmacist, doctor, or local poison control.
          </p>
        </div>
        <div className="mx-5 rounded-2xl p-4" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
          <p className="text-[13px] font-semibold text-[#3A4048] mb-1">Therapy & behavioral notes</p>
          <p className="text-[12.5px] text-[#6B7480] leading-relaxed">
            Notes about regulation strategies, triggers, or incidents are your own observations, not clinical assessments. This app
            doesn't interpret, diagnose, or recommend approaches — for guidance on therapy or behavioral support, talk to your child's
            care team.
          </p>
        </div>
      </SettingsSubpage>
    );
  }

  if (section === "security") {
    return (
      <SettingsSubpage title="Security" onBack={() => setSection(null)}>
        <button onClick={() => setSection("password")} className="w-full flex items-center justify-between px-4 py-3.5" style={{ backgroundColor: "white", WebkitAppearance: "none" }}>
          <span className="text-[14px] text-[#3A4048] font-medium">Change password</span>
          <ChevRight size={16} color="#C4CDD6" />
        </button>
      </SettingsSubpage>
    );
  }

  if (section === "password") {
    return <ChangePasswordSubpage onBack={() => setSection("security")} />;
  }

  return (
    <div>
      <div className="px-6 pt-8 pb-4">
        <p className="text-[13px] tracking-wide text-[#8A94A0] uppercase font-semibold">Account</p>
        <h1 className="font-display text-[26px] text-[#3A4048] mt-1">Settings</h1>
      </div>

      <div className="mx-5 rounded-3xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {rows.map((r, i) => (
          <button key={r.key} onClick={() => setSection(r.key)}
            className="w-full flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: i < rows.length - 1 ? "1px solid #EEF3F7" : "none", backgroundColor: "white", WebkitAppearance: "none" }}>
            <r.icon size={17} color="#4A7FAE" className="shrink-0" />
            <span className="text-[14px] text-[#3A4048] font-medium flex-1 text-left">{r.label}</span>
            <ChevRight size={16} color="#C4CDD6" />
          </button>
        ))}
      </div>

      <div className="mx-5 mb-6">
        <button onClick={onLogout} className="w-full box-border relative flex items-center justify-center rounded-2xl py-3.5"
          style={{ backgroundColor: "white", border: "1px solid #F0D9D5", color: "#C67B6C", WebkitAppearance: "none" }}>
          <LogOut size={16} className="absolute left-4" />
          <span className="text-[14px] font-semibold">Log out</span>
        </button>
      </div>

      {/* Preview-only tool — not a real product feature, remove before this ships.
          Lets you test "Remember me" and other cold-start behavior without actually
          closing and reopening the artifact. */}
      <p className="px-6 mb-2 text-[11px] font-semibold tracking-wide uppercase text-[#B7C3CC]">Preview tools</p>
      <div className="mx-5 mb-2 rounded-2xl p-3" style={{ backgroundColor: "#F7F9FB", border: "1px dashed #C9D2DA" }}>
        <p className="text-[12px] font-semibold text-[#8A94A0] mb-2">My role (for testing permissions)</p>
        <div className="flex gap-1.5">
          {["owner", "full", "view"].map((r) => (
            <button
              key={r}
              onClick={() => {
                const next = { ...household, members: household.members.map((m) => (m.isYou ? { ...m, role: r } : m)) };
                persistHousehold(next);
              }}
              className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: myRole === r ? "#4A7FAE" : "white", color: myRole === r ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}
            >
              {ROLE_META[r].label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[#B7C3CC] mt-2 leading-relaxed">
          Real apps wouldn't let you change your own role — this exists purely so you can see what a View-only caregiver
          actually can and can't do, since this prototype only has one real user.
        </p>
      </div>
      <div className="mx-5">
        <button onClick={onSimulateReopen} className="w-full box-border flex items-center justify-center gap-2 rounded-2xl py-3"
          style={{ backgroundColor: "#F7F9FB", border: "1px dashed #C9D2DA", color: "#8A94A0", WebkitAppearance: "none" }}>
          <RefreshCw size={14} /><span className="text-[13px] font-semibold">Simulate closing & reopening the app</span>
        </button>
      </div>
    </div>
  );
}

function SettingsSectionLabel({ children }) {
  return <p className="px-6 mb-2 mt-4 text-[12px] font-semibold tracking-wide uppercase text-[#8A94A0] first:mt-0">{children}</p>;
}

function EditableField({ label, value, placeholder, type = "text", onSave, last, format }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || "");

  const save = () => { onSave(val.trim()); setEditing(false); };

  return (
    <div className="mx-5 rounded-3xl mb-2 overflow-hidden" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
      <div className="px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1">{label}</p>
        {editing ? (
          <div className="flex items-center gap-2">
            <input autoFocus type={type} value={val} onChange={(e) => setVal(format ? format(e.target.value) : e.target.value)} placeholder={placeholder}
              className="flex-1 text-[15px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none", borderBottom: "1px solid #DCEAF5" }} />
            <button onClick={save} className="text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>Save</button>
            <button onClick={() => { setVal(value || ""); setEditing(false); }} className="text-[13px] font-semibold text-[#8A94A0]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>Cancel</button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-[15px]" style={{ color: value ? "#3A4048" : "#B7C3CC" }}>{value || placeholder}</span>
            <button onClick={() => setEditing(true)} className="text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>Edit</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChangePasswordSubpage({ onBack }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSave = current.length > 0 && next.length >= 6 && next === confirm;

  const save = () => {
    if (!canSave) return;
    setSaved(true);
  };

  if (saved) {
    return (
      <SettingsSubpage title="Change password" onBack={onBack} noCard>
        <div className="mx-5 rounded-2xl p-5 text-center" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
          <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ backgroundColor: "#5FA663" }}>
            <Check size={22} color="white" />
          </div>
          <p className="text-[15px] font-semibold text-[#3A4048] mb-1">Password updated</p>
          <p className="text-[13px] text-[#8A94A0]">Use your new password next time you log in.</p>
          <button onClick={onBack} className="mt-4 text-[13px] font-semibold text-[#4A7FAE]" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
            Back to Security
          </button>
        </div>
      </SettingsSubpage>
    );
  }

  return (
    <SettingsSubpage title="Change password" onBack={onBack} noCard>
      <div className="mx-5 rounded-2xl p-4 flex flex-col gap-3 mb-3" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Current password</p>
          <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ border: "1px solid #DCEAF5" }}>
            <input type={showCurrent ? "text" : "password"} value={current} onChange={(e) => setCurrent(e.target.value)}
              className="flex-1 text-[14px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
            <button onClick={() => setShowCurrent((v) => !v)} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
              {showCurrent ? <EyeOff size={16} color="#8A94A0" /> : <Eye size={16} color="#8A94A0" />}
            </button>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">New password</p>
          <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ border: "1px solid #DCEAF5" }}>
            <input type={showNext ? "text" : "password"} value={next} onChange={(e) => setNext(e.target.value)}
              placeholder="6+ characters" className="flex-1 text-[14px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
            <button onClick={() => setShowNext((v) => !v)} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
              {showNext ? <EyeOff size={16} color="#8A94A0" /> : <Eye size={16} color="#8A94A0" />}
            </button>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Confirm new password</p>
          <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ border: `1px solid ${mismatch ? "#E2B7AE" : "#DCEAF5"}` }}>
            <input type={showNext ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)}
              className="flex-1 text-[14px] text-[#3A4048] outline-none bg-transparent" style={{ WebkitAppearance: "none" }} />
          </div>
          {mismatch && <p className="text-[11px] text-[#C67B6C] mt-1">Passwords don't match.</p>}
        </div>
      </div>

      <div className="mx-5">
        <button onClick={save} disabled={!canSave} className="w-full box-border rounded-2xl py-3.5 font-semibold text-[15px]"
          style={{ WebkitAppearance: "none", backgroundColor: canSave ? "#4A7FAE" : "#C4CDD6", color: "white" }}>
          Save new password
        </button>
      </div>

      <p className="px-6 mt-4 text-[11px] text-[#B7C3CC] leading-relaxed">
        This is a preview build — there's no real account behind it yet, so your current password isn't actually verified here. Once real
        authentication is in place, this same screen will check it for real before allowing a change.
      </p>
    </SettingsSubpage>
  );
}

// ---------------------------------------------------------------------------
// Plan — shows the business model live in-product, not just in a deck.
// Illustrative only: there's no real billing here, same honesty standard as
// everything else in this preview.
// ---------------------------------------------------------------------------
function PlanScreen({ onBack }) {
  const tiers = [
    {
      name: "Free", price: "$0", period: "forever", color: "#8A94A0", highlight: false,
      desc: "Everything a single household needs to start tracking today.",
      features: ["One household, one child", "Full Today, Timeline, and Info Bank", "Real-time countdowns and reminders", "Unlimited logged history"],
    },
    {
      name: "Family", price: "$9", period: "/ month", color: "#4A7FAE", highlight: true,
      desc: "For households with more than one caregiver, more than one kid, or care that splits across homes.",
      features: ["Unlimited caregivers and children", "Multiple households, one account", "Roles and permissions", "History export for doctors and specialists", "Priority support"],
    },
    {
      name: "Care Team", price: "Custom", period: "pricing", color: "#C99A4E", highlight: false,
      desc: "For agencies, therapy practices, and care coordinators supporting multiple families at once.",
      features: ["Everything in Family, per household", "Coordinator-level oversight across families", "Team billing and provisioning", "Dedicated onboarding"],
    },
  ];

  return (
    <SettingsSubpage title="Plan" onBack={onBack} noCard>
      <div className="px-6 -mt-2 mb-4">
        <p className="text-[13px] text-[#8A94A0] leading-relaxed">
          This is a preview of the business model — there's no real billing wired up yet, same as everything else marked as a work in progress in this prototype.
        </p>
      </div>

      <div className="flex flex-col gap-3 px-5">
        {tiers.map((t) => (
          <div key={t.name} className="rounded-3xl overflow-hidden"
            style={{ backgroundColor: t.highlight ? t.color : "white", border: t.highlight ? "none" : "1px solid #DCEAF5" }}>
            <div className="p-5">
              {t.highlight && (
                <p className="text-[10px] font-bold uppercase tracking-wide mb-2" style={{ color: "#F5D999" }}>Recommended</p>
              )}
              <div className="flex items-end justify-between mb-1">
                <h2 className="font-display text-[22px] font-bold" style={{ color: t.highlight ? "white" : "#3A4048" }}>{t.name}</h2>
                <div className="text-right">
                  <span className="text-[22px] font-bold" style={{ color: t.highlight ? "white" : "#3A4048" }}>{t.price}</span>
                  <span className="text-[12px] ml-1" style={{ color: t.highlight ? "#E4EDF6" : "#8A94A0" }}>{t.period}</span>
                </div>
              </div>
              <p className="text-[13px] mb-4" style={{ color: t.highlight ? "#E4EDF6" : "#8A94A0" }}>{t.desc}</p>
              <div className="flex flex-col gap-2">
                {t.features.map((f) => (
                  <div key={f} className="flex items-start gap-2">
                    <Check size={14} color={t.highlight ? "#F5D999" : t.color} className="shrink-0 mt-0.5" />
                    <span className="text-[13px]" style={{ color: t.highlight ? "white" : "#3A4048" }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </SettingsSubpage>
  );
}

function CategoryColorsScreen({ settings, persistSettings, onBack, speakText }) {
  const overrides = settings.categoryColors || {};

  const setColor = (key, color) => {
    persistSettings({ ...settings, categoryColors: { ...overrides, [key]: color } });
    speakText?.(`${CATEGORY_META[key].label} color updated`);
  };
  const applyColorblindPalette = () => {
    persistSettings({ ...settings, categoryColors: { ...COLORBLIND_PALETTE } });
  };
  const resetAll = () => {
    persistSettings({ ...settings, categoryColors: {} });
  };
  const isUsingColorblindPalette = Object.keys(CATEGORY_META).every(
    (k) => (overrides[k] || DEFAULT_CATEGORY_COLORS[k]) === COLORBLIND_PALETTE[k]
  );

  return (
    <SettingsSubpage title="Category Colors" onBack={onBack} noCard>
      <div className="px-6 -mt-2 mb-4">
        <p className="text-[13px] text-[#8A94A0] leading-relaxed">
          Every category icon and status ring uses these colors throughout the app. If the default set is
          hard to tell apart, switch to a colorblind-friendly palette or pick your own for each one.
        </p>
      </div>

      <div className="px-5 mb-4">
        <button onClick={applyColorblindPalette} className="w-full box-border rounded-2xl py-3 flex items-center justify-center gap-2"
          style={{ WebkitAppearance: "none", backgroundColor: isUsingColorblindPalette ? "#4A7FAE" : "#F2F7FB", border: isUsingColorblindPalette ? "none" : "1px solid #DCEAF5" }}>
          {isUsingColorblindPalette && <Check size={15} color="white" />}
          <span className="text-[13.5px] font-semibold" style={{ color: isUsingColorblindPalette ? "white" : "#4A7FAE" }}>
            {isUsingColorblindPalette ? "Using colorblind-friendly palette" : "Use colorblind-friendly palette"}
          </span>
        </button>
        <p className="text-[11px] text-[#B7C3CC] mt-1.5 leading-relaxed">
          Based on the Okabe–Ito palette, a well-established set of colors chosen to stay distinguishable
          across the common forms of color blindness.
        </p>
      </div>

      <div className="mx-5 rounded-3xl overflow-hidden mb-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        {Object.entries(CATEGORY_META).map(([key, meta], i, arr) => {
          const Icon = meta.icon;
          return (
            <div key={key} className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: i < arr.length - 1 ? "1px solid #EEF3F7" : "none" }}>
              <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${meta.color}` }}>
                <Icon size={16} color={meta.color} />
              </div>
              <span className="text-[14px] font-semibold text-[#3A4048] flex-1">{meta.label}</span>
              <div className="relative w-9 h-9 shrink-0 rounded-full overflow-hidden" style={{ border: "1px solid #DCEAF5" }}>
                <input type="color" value={meta.color} onChange={(e) => setColor(key, e.target.value)}
                  className="absolute p-0 border-none cursor-pointer" style={{ top: -4, left: -4, width: 44, height: 44 }} aria-label={`${meta.label} color`} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-5">
        <button onClick={resetAll} className="w-full box-border text-center py-2" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
          <span className="text-[13px] font-semibold text-[#8A94A0]">Reset all to default colors</span>
        </button>
      </div>
    </SettingsSubpage>
  );
}

function AccessibilityScreen({ settings, persistSettings, onBack }) {
  const supported = typeof window !== "undefined" && !!window.speechSynthesis;
  return (
    <SettingsSubpage title="Accessibility" onBack={onBack} noCard>
      <div className="px-6 -mt-2 mb-4">
        <p className="text-[13px] text-[#8A94A0] leading-relaxed">
          Tools for reading, seeing, and hearing the app more easily. More will be added here over time.
        </p>
      </div>

      <div className="mx-5 rounded-3xl p-4" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[14px] font-semibold text-[#3A4048]">Read Aloud</span>
          <Toggle on={settings.readAloud} onClick={() => persistSettings({ ...settings, readAloud: !settings.readAloud })} />
        </div>
        <p className="text-[12.5px] text-[#8A94A0] leading-relaxed">
          Tap any text on screen and it's highlighted and read aloud — meant for low vision, reading
          difficulties, or anyone who finds it easier to follow along by ear. It doesn't change what a tap
          does — buttons and links still work exactly as normal, this just adds a spoken echo alongside them.
        </p>
        {!supported && (
          <p className="text-[11.5px] text-[#C67B6C] mt-2 leading-relaxed">
            This browser doesn't support text-to-speech, so this won't do anything here yet — it'll work
            once the app is running somewhere with that support.
          </p>
        )}
      </div>
    </SettingsSubpage>
  );
}


function SettingsSubpage({ title, onBack, children, noCard }) {
  return (
    <div>
      <div className="px-6 pt-8 pb-4 flex items-center gap-3">
        <button onClick={onBack} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><ChevronLeft size={20} color="#4A7FAE" /></button>
        <h1 className="font-display text-[22px] text-[#3A4048]">{title}</h1>
      </div>
      {noCard ? children : (
        <div className="mx-5 rounded-3xl overflow-hidden" style={{ backgroundColor: "white", border: "1px solid #DCEAF5" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function SettingsToggleRow({ label, desc, on, onClick, last }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: last ? "none" : "1px solid #EEF3F7" }}>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-[#3A4048] font-medium">{label}</p>
        <p className="text-[12px] text-[#8A94A0] mt-0.5">{desc}</p>
      </div>
      <Toggle on={on} onClick={onClick} />
    </div>
  );
}

function QuickLogModal({ kids, activeChildId, items, now, onLog, onAddFreeform, onSchedule, onCreatePreset, onEditPreset, onDeletePreset, onClose, myRole, targetDayKey, speakText }) {
  const isToday = targetDayKey === dateKey(new Date());
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [mode, setMode] = useState(isToday && items.length > 0 ? "presets" : "custom");
  const [addPresetOpen, setAddPresetOpen] = useState(false);
  const [selectedKids, setSelectedKids] = useState([activeChildId]);
  const [category, setCategory] = useState("medication");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [time, setTime] = useState(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [trackGoing, setTrackGoing] = useState(false);
  const [timingModel, setTimingModel] = useState("asNeeded");
  const [intervalHours, setIntervalHours] = useState("");
  const [intervalUnit, setIntervalUnit] = useState("hours");
  const [minGapHours, setMinGapHours] = useState("");
  const [minGapUnit, setMinGapUnit] = useState("hours");

  // Builds the timestamp from the actual day being logged for — not always "today" — so
  // backfilling a past day in Timeline reflects that day's date, not the moment you hit save.
  const targetDateBase = () => {
    const [y, m, d] = (targetDayKey || dateKey(new Date())).split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const timeToTimestamp = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = targetDateBase(); d.setHours(h, m, 0, 0);
    return isToday ? Math.min(d.getTime(), Date.now()) : d.getTime(); // only clamp "can't be future" when logging for today
  };
  const fmtTimeLabel = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = targetDateBase(); d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  const trackingValueValid = timingModel === "scheduled" ? Number(intervalHours) > 0 : Number(minGapHours) > 0;
  const canSubmit = title.trim().length > 0 && (!trackGoing || trackingValueValid) && selectedKids.length > 0;

  const toggleKid = (id) => {
    setSelectedKids((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((k) => k !== id);
        return next.length === 0 ? prev : next; // always keep at least one selected
      }
      return [...prev, id];
    });
  };
  const selectedNames = kids.filter((k) => selectedKids.includes(k.id)).map((k) => k.name);
  const forLabel = selectedNames.length <= 2 ? selectedNames.join(" & ") : `${selectedNames.length} kids`;

  const submitCustom = () => {
    if (!canSubmit) return;
    const intervalHoursFinal = intervalUnit === "minutes" ? Number(intervalHours) / 60 : Number(intervalHours);
    const minGapHoursFinal = minGapUnit === "minutes" ? Number(minGapHours) / 60 : Number(minGapHours);
    onAddFreeform(selectedKids, {
      category, title: title.trim(), subtitle: subtitle.trim() || CATEGORY_META[category].label,
      time: fmtTimeLabel(time), timestamp: timeToTimestamp(time), trackGoing: isToday && trackGoing, timingModel,
      intervalHours: intervalHoursFinal, minGapHours: minGapHoursFinal,
    });
  };

  return (
    <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 50 }} onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display text-[19px] text-[#3A4048]">Log for {forLabel}</h2>
          <button onClick={onClose} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
        </div>
        {!isToday && (
          <p className="text-[12px] font-semibold text-[#4A7FAE] mb-3">
            Logging for {formatEntryDate(targetDayKey)} — not today
          </p>
        )}
        {isToday && <div className="mb-4" />}

        {kids.length > 1 && (mode === "custom" || mode === "schedule" || (mode === "presets" && addPresetOpen)) && (
          <div className="mb-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">For</p>
            <div className="flex gap-1.5 flex-wrap">
              {kids.map((k) => {
                const active = selectedKids.includes(k.id);
                return (
                  <button key={k.id} onClick={() => toggleKid(k.id)} className="flex items-center gap-1.5 pl-1.5 pr-3 py-1.5 rounded-full"
                    style={{ WebkitAppearance: "none", backgroundColor: active ? "#4A7FAE" : "#F2F7FB", border: active ? "none" : "1px solid #DCEAF5" }}>
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{ backgroundColor: active ? "rgba(255,255,255,0.25)" : "rgba(74,127,174,0.15)", color: active ? "white" : "#4A7FAE" }}>
                      {k.initials}
                    </div>
                    <span className="text-[12.5px] font-semibold" style={{ color: active ? "white" : "#4A7FAE" }}>{k.name}</span>
                  </button>
                );
              })}
            </div>
            {selectedKids.length > 1 && (
              <p className="text-[11px] text-[#8A94A0] mt-1.5 leading-relaxed">
                This logs the same entry for all {selectedKids.length} kids at once — handy for something like giving the same dose to twins.
              </p>
            )}
          </div>
        )}

        {isToday && (
          <div className="flex gap-1.5 mb-4">
            <button onClick={() => setMode("presets")} className="flex-1 py-2 rounded-xl text-[12.5px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: mode === "presets" ? "#4A7FAE" : "#F2F7FB", color: mode === "presets" ? "white" : "#4A7FAE" }}>
              Quick tap
            </button>
            <button onClick={() => setMode("custom")} className="flex-1 py-2 rounded-xl text-[12.5px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: mode === "custom" ? "#4A7FAE" : "#F2F7FB", color: mode === "custom" ? "white" : "#4A7FAE" }}>
              Log something else
            </button>
            <button onClick={() => setMode("schedule")} className="flex-1 py-2 rounded-xl text-[12.5px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: mode === "schedule" ? "#4A7FAE" : "#F2F7FB", color: mode === "schedule" ? "white" : "#4A7FAE" }}>
              Schedule for later
            </button>
          </div>
        )}

        {mode === "presets" && (
          <div className="flex flex-col gap-2">
            {items.length === 0 && !addPresetOpen && <p className="text-[13px] text-[#8A94A0] text-center py-4">No quick taps set up yet.</p>}
            {items.map((item) => {
              const status = getStatus(item, now);
              const meta = CATEGORY_META[item.category];
              const Icon = meta.icon;
              return (
                <div key={item.id} className="w-full flex items-stretch gap-2 rounded-2xl overflow-hidden" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
                  <button onClick={() => onLog(item.id)} className="flex-1 flex items-center gap-3 px-4 py-3" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${status.color}` }}>
                      <Icon size={14} color={meta.color} />
                    </div>
                    <div className="min-w-0 flex-1 text-left"><p className="text-[14px] text-[#3A4048] font-semibold truncate">{item.title}</p><p className="text-[12px] text-[#8A94A0] truncate">{item.subtitle}</p></div>
                    <span className="text-[12px] font-semibold text-[#4A7FAE] shrink-0">Log now</span>
                  </button>
                  <button onClick={() => setSelectedPreset(item)} className="px-3 flex items-center justify-center shrink-0" style={{ backgroundColor: "transparent", borderLeft: "1px solid #EEF3F7", WebkitAppearance: "none" }} aria-label="Edit">
                    <Pencil size={14} color="#8A94A0" />
                  </button>
                </div>
              );
            })}

            {!addPresetOpen ? (
              <button onClick={() => setAddPresetOpen(true)} className="w-full box-border rounded-2xl border-2 border-dashed py-3 flex items-center justify-center gap-2"
                style={{ backgroundColor: "#F7F9FB", borderColor: "#4A7FAE", WebkitAppearance: "none" }}>
                <Plus size={15} color="#4A7FAE" /><span className="text-[13px] font-semibold text-[#4A7FAE]">Add a quick tap</span>
              </button>
            ) : (
              <AddPresetForm onCreate={async (data) => { await onCreatePreset(selectedKids, data); setAddPresetOpen(false); }} onCancel={() => setAddPresetOpen(false)} />
            )}
          </div>
        )}

        {mode === "custom" && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
              <div className="flex gap-1.5 flex-wrap">
                {Object.entries(CATEGORY_META).map(([key, meta]) => (
                  <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: category === key ? meta.color : "#F2F7FB", color: category === key ? "white" : meta.color }}>
                    {meta.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">What happened</p>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Took Tylenol, Went to school, Meltdown"
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Details (optional)</p>
              <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="e.g. 5 mL, Room 4B, loud noise trigger"
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Time</p>
              <input type="time" value={time} onChange={(e) => { setTime(e.target.value); speakText?.(`Time set to ${formatTimeForSpeech(e.target.value)}`); }}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>

            {isToday && (
              <button onClick={() => setTrackGoing((v) => !v)} className="flex items-center gap-2 mt-1" style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}>
                <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ border: `1.5px solid ${trackGoing ? "#4A7FAE" : "#C4CDD6"}`, backgroundColor: trackGoing ? "#4A7FAE" : "white" }}>
                  {trackGoing && <Check size={13} color="white" />}
                </div>
                <span className="text-[13px] text-[#3A4048] text-left">Track this going forward on Today</span>
              </button>
            )}

            {isToday && trackGoing && (
              <div className="rounded-2xl p-3" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-2">Repeats</p>
                <div className="flex gap-1.5 mb-2">
                  <button onClick={() => setTimingModel("scheduled")} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: timingModel === "scheduled" ? "#4A7FAE" : "white", color: timingModel === "scheduled" ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
                    On a schedule
                  </button>
                  <button onClick={() => setTimingModel("asNeeded")} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: timingModel === "asNeeded" ? "#4A7FAE" : "white", color: timingModel === "asNeeded" ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
                    As needed
                  </button>
                </div>
                {timingModel === "scheduled" ? (
                  <div className="flex items-center gap-2 text-[13px] text-[#3A4048] flex-wrap">
                    Every
                    <input type="number" min="1" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} placeholder="?" required
                      className="w-16 text-[13px] px-2 py-1 rounded-lg text-center" style={{ border: `1px solid ${intervalHours ? "#DCEAF5" : "#E2B7AE"}`, WebkitAppearance: "none" }} />
                    <UnitToggle unit={intervalUnit} setUnit={setIntervalUnit} />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[13px] text-[#3A4048] flex-wrap">
                    Wait at least
                    <input type="number" min="1" value={minGapHours} onChange={(e) => setMinGapHours(e.target.value)} placeholder="?" required
                      className="w-16 text-[13px] px-2 py-1 rounded-lg text-center" style={{ border: `1px solid ${minGapHours ? "#DCEAF5" : "#E2B7AE"}`, WebkitAppearance: "none" }} />
                    <UnitToggle unit={minGapUnit} setUnit={setMinGapUnit} />
                    <span>before next</span>
                  </div>
                )}
                <p className="text-[11px] text-[#8A94A0] mt-2 leading-relaxed">
                  Enter the interval from your child's doctor, pharmacist, or the medication label. This app only tracks what you enter — it never sets or suggests a timing value for you.
                </p>
              </div>
            )}

            <button onClick={submitCustom} disabled={!canSubmit} className="mt-1 rounded-2xl py-3 font-semibold text-[15px]"
              style={{ WebkitAppearance: "none", backgroundColor: canSubmit ? "#4A7FAE" : "#C4CDD6", color: "white" }}>
              Add to today's log
            </button>
          </div>
        )}

        {mode === "schedule" && <ScheduleForm forLabel={forLabel} onSchedule={(data) => onSchedule(selectedKids, data)} speakText={speakText} />}
      </div>

      {selectedPreset && (
        <EditPresetModal
          item={selectedPreset}
          myRole={myRole}
          now={now}
          onClose={() => setSelectedPreset(null)}
          onSave={async (patch) => { await onEditPreset(selectedPreset.id, patch); setSelectedPreset(null); }}
          onDelete={async () => { await onDeletePreset(selectedPreset.id); setSelectedPreset(null); }}
          onLogNow={async () => { await onLog(selectedPreset.id); setSelectedPreset(null); onClose(); }}
        />
      )}
    </div>
  );
}

function EditPresetModal({ item, myRole, now, onClose, onSave, onDelete, onLogNow }) {
  const [mode, setMode] = useState("view"); // view | edit
  const [category, setCategory] = useState(item.category);
  const [title, setTitle] = useState(item.title);
  const [subtitle, setSubtitle] = useState(item.subtitle || "");
  const [timingModel, setTimingModel] = useState(item.timingModel);
  const intervalDefault = hoursToUnitDefault(item.timingModel === "scheduled" ? item.intervalHours : 0);
  const minGapDefault = hoursToUnitDefault(item.timingModel === "asNeeded" ? item.minGapHours : 0);
  const [intervalHours, setIntervalHours] = useState(intervalDefault.value);
  const [intervalUnit, setIntervalUnit] = useState(intervalDefault.unit);
  const [minGapHours, setMinGapHours] = useState(minGapDefault.value);
  const [minGapUnit, setMinGapUnit] = useState(minGapDefault.unit);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canWrite = myRole !== "view";
  const status = getStatus(item, now);
  const meta = CATEGORY_META[item.category];
  const Icon = meta.icon;

  const trackingValueValid = timingModel === "scheduled" ? Number(intervalHours) > 0 : Number(minGapHours) > 0;
  const canSave = title.trim().length > 0 && trackingValueValid;

  const save = () => {
    if (!canSave) return;
    const gapValue = timingModel === "scheduled"
      ? (intervalUnit === "minutes" ? Number(intervalHours) / 60 : Number(intervalHours))
      : (minGapUnit === "minutes" ? Number(minGapHours) / 60 : Number(minGapHours));
    onSave({
      category, title: title.trim(), subtitle: subtitle.trim(), timingModel,
      ...(timingModel === "scheduled" ? { intervalHours: gapValue, minGapHours: undefined } : { minGapHours: gapValue, intervalHours: undefined }),
    });
  };

  return (
    <div className="absolute inset-0 flex items-end justify-center" style={{ backgroundColor: "rgba(58,64,72,0.35)", zIndex: 60 }} onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[19px] text-[#3A4048]">{mode === "edit" ? "Edit quick tap" : "Quick tap"}</h2>
          <button onClick={onClose} style={{ backgroundColor: "transparent", WebkitAppearance: "none" }}><X size={20} color="#8A94A0" /></button>
        </div>

        {mode === "view" ? (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: "white", border: `1.5px solid ${status.color}` }}>
                <Icon size={20} color={meta.color} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[17px] text-[#3A4048] font-semibold truncate">{item.title}</p>
                <p className="text-[13px] text-[#8A94A0] truncate">{item.subtitle}</p>
              </div>
            </div>

            <div className="rounded-2xl overflow-hidden mb-6" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Category</span>
                <span className="text-[13px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid #EEF3F7" }}>
                <span className="text-[12px] text-[#8A94A0]">Last done</span>
                <span className="tnum text-[13px] font-medium text-[#3A4048]">{fmtElapsed(status.elapsed)} ago</span>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[12px] text-[#8A94A0]">{status.label}</span>
                <span className="tnum text-[13px] font-semibold" style={{ color: status.color }}>{status.ready ? "Now" : fmtCountdown(status.remaining)}</span>
              </div>
            </div>

            {canWrite ? (
              <div className="flex flex-col gap-2">
                <button onClick={onLogNow} className="w-full rounded-2xl py-3 font-semibold text-[14px]" style={{ backgroundColor: "#4A7FAE", color: "white", WebkitAppearance: "none" }}>
                  Log now
                </button>
                <div className="flex gap-2">
                  <button onClick={() => setMode("edit")} className="flex-1 rounded-2xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#4A7FAE", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Edit</button>
                  <button onClick={() => setConfirmDelete(true)} className="flex-1 rounded-2xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>Delete</button>
                </div>
                {confirmDelete && (
                  <div className="rounded-2xl p-4 mt-1" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                    <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Delete "{item.title}"? This can't be undone, and it won't remove entries already logged in the Timeline.</p>
                    <div className="flex gap-2">
                      <button onClick={onDelete} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Delete</button>
                      <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-[#B7C3CC] text-center py-2">View-only access — ask an owner or full-access caregiver to make changes.</p>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
              <div className="flex gap-1.5 flex-wrap">
                {Object.entries(CATEGORY_META).map(([key, m]) => (
                  <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
                    style={{ WebkitAppearance: "none", backgroundColor: category === key ? m.color : "#F2F7FB", color: category === key ? "white" : m.color }}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Name</p>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Details</p>
              <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
                className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Repeats</p>
              <div className="flex gap-1.5 mb-2">
                <button onClick={() => setTimingModel("scheduled")} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
                  style={{ WebkitAppearance: "none", backgroundColor: timingModel === "scheduled" ? "#4A7FAE" : "white", color: timingModel === "scheduled" ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
                  On a schedule
                </button>
                <button onClick={() => setTimingModel("asNeeded")} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
                  style={{ WebkitAppearance: "none", backgroundColor: timingModel === "asNeeded" ? "#4A7FAE" : "white", color: timingModel === "asNeeded" ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
                  As needed
                </button>
              </div>
              {timingModel === "scheduled" ? (
                <div className="flex items-center gap-2 text-[13px] text-[#3A4048] flex-wrap">
                  Every
                  <input type="number" min="1" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} placeholder="?"
                    className="w-16 text-[13px] px-2 py-1 rounded-lg text-center" style={{ border: `1px solid ${intervalHours ? "#DCEAF5" : "#E2B7AE"}`, WebkitAppearance: "none" }} />
                  <UnitToggle unit={intervalUnit} setUnit={setIntervalUnit} />
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[13px] text-[#3A4048] flex-wrap">
                  Wait at least
                  <input type="number" min="1" value={minGapHours} onChange={(e) => setMinGapHours(e.target.value)} placeholder="?"
                    className="w-16 text-[13px] px-2 py-1 rounded-lg text-center" style={{ border: `1px solid ${minGapHours ? "#DCEAF5" : "#E2B7AE"}`, WebkitAppearance: "none" }} />
                  <UnitToggle unit={minGapUnit} setUnit={setMinGapUnit} />
                  <span>before next</span>
                </div>
              )}
              <p className="text-[11px] text-[#8A94A0] mt-2 leading-relaxed">
                Changing this only updates the schedule going forward — it won't reset the current countdown.
              </p>
            </div>

            {!confirmDelete ? (
              <div className="flex gap-2 mt-1">
                <button onClick={save} disabled={!canSave} className="flex-1 rounded-2xl py-3 font-semibold text-[14px]"
                  style={{ WebkitAppearance: "none", backgroundColor: canSave ? "#4A7FAE" : "#C4CDD6", color: "white" }}>Save</button>
                <button onClick={() => setMode("view")} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                <button onClick={() => setConfirmDelete(true)} className="rounded-2xl py-3 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#C67B6C", border: "1px solid #F0D9D5", WebkitAppearance: "none" }}>Delete</button>
              </div>
            ) : (
              <div className="rounded-2xl p-4" style={{ backgroundColor: "#FBF1EF", border: "1px solid #F0D9D5" }}>
                <p className="text-[13px] font-semibold text-[#8A4A3D] mb-3">Delete "{item.title}"? This can't be undone, and it won't remove entries already logged in the Timeline.</p>
                <div className="flex gap-2">
                  <button onClick={onDelete} className="flex-1 rounded-xl py-2.5 font-semibold text-[13px]" style={{ backgroundColor: "#C67B6C", color: "white", WebkitAppearance: "none" }}>Delete</button>
                  <button onClick={() => setConfirmDelete(false)} className="rounded-xl py-2.5 px-4 font-semibold text-[13px]" style={{ backgroundColor: "white", color: "#8A94A0", border: "1px solid #DCEAF5", WebkitAppearance: "none" }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleForm({ forLabel, onSchedule, speakText }) {
  const [category, setCategory] = useState("therapy");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [notes, setNotes] = useState("");
  const [recurrence, setRecurrence] = useState("none");
  const todayStr = dateKey(new Date());
  const nowHHMM = (() => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })();
  const [date, setDate] = useState(todayStr);
  const [time, setTime] = useState(nowHHMM);
  const [done, setDone] = useState(false);

  const timestamp = (() => {
    const [y, m, d] = date.split("-").map(Number);
    const [h, min] = time.split(":").map(Number);
    return new Date(y, m - 1, d, h, min, 0, 0).getTime();
  })();
  const isFuture = timestamp > Date.now();
  const canSubmit = title.trim().length > 0 && isFuture;

  const submit = () => {
    if (!canSubmit) return;
    onSchedule({ category, title: title.trim(), subtitle: subtitle.trim(), notes: notes.trim(), timestamp, recurrence });
    setDone(true);
  };

  if (done) {
    return (
      <div className="text-center py-6">
        <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ backgroundColor: "#5FA663" }}>
          <Check size={22} color="white" />
        </div>
        <p className="text-[15px] font-semibold text-[#3A4048]">Scheduled</p>
        <p className="text-[13px] text-[#8A94A0] mt-1">You'll see it on the Today screen for {forLabel} as it gets closer.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(CATEGORY_META).map(([key, meta]) => (
            <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: category === key ? meta.color : "#F2F7FB", color: category === key ? "white" : meta.color }}>
              {meta.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">What's happening</p>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. OT eval, Dentist appointment"
          className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Details (optional)</p>
        <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="e.g. Dr. Ochoa's office"
          className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Date</p>
          <input type="date" value={date} min={todayStr} onChange={(e) => {
            setDate(e.target.value);
            speakText?.(`Date set to ${new Date(e.target.value + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`);
          }}
            className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
        </div>
        <div className="flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Time</p>
          <input type="time" value={time} onChange={(e) => { setTime(e.target.value); speakText?.(`Time set to ${formatTimeForSpeech(e.target.value)}`); }}
            className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
        </div>
      </div>
      {!isFuture && title.trim().length > 0 && (
        <p className="text-[11px] text-[#C67B6C]">That time has already passed — pick a moment in the future.</p>
      )}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Repeats</p>
        <div className="flex gap-1.5">
          {[["none", "Just once"], ["weekly", "Weekly"], ["monthly", "Monthly"]].map(([key, label]) => (
            <button key={key} onClick={() => setRecurrence(key)} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: recurrence === key ? "#4A7FAE" : "white", color: recurrence === key ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Notes (optional)</p>
        <input value={notes} onChange={(e) => setNotes(e.target.value)}
          className="w-full text-[14px] px-3 py-2.5 rounded-xl text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      </div>
      <button onClick={submit} disabled={!canSubmit} className="mt-1 rounded-2xl py-3 font-semibold text-[15px]"
        style={{ WebkitAppearance: "none", backgroundColor: canSubmit ? "#4A7FAE" : "#C4CDD6", color: "white" }}>
        Schedule it
      </button>
    </div>
  );
}

// Creates a new recurring "quick tap" item directly — for setting up a schedule ahead of
// time, not just as a side effect of logging something that already happened.
function AddPresetForm({ onCreate, onCancel }) {
  const [category, setCategory] = useState("medication");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [timingModel, setTimingModel] = useState("asNeeded");
  const [intervalHours, setIntervalHours] = useState("");
  const [intervalUnit, setIntervalUnit] = useState("hours");
  const [minGapHours, setMinGapHours] = useState("");
  const [minGapUnit, setMinGapUnit] = useState("hours");

  const trackingValueValid = timingModel === "scheduled" ? Number(intervalHours) > 0 : Number(minGapHours) > 0;
  const canSubmit = title.trim().length > 0 && trackingValueValid;

  const submit = () => {
    if (!canSubmit) return;
    const intervalHoursFinal = intervalUnit === "minutes" ? Number(intervalHours) / 60 : Number(intervalHours);
    const minGapHoursFinal = minGapUnit === "minutes" ? Number(minGapHours) / 60 : Number(minGapHours);
    onCreate({ category, title: title.trim(), subtitle: subtitle.trim() || CATEGORY_META[category].label, timingModel, intervalHours: intervalHoursFinal, minGapHours: minGapHoursFinal });
  };

  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: "#F7F9FB", border: "1px solid #EEF3F7" }}>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Category</p>
        <div className="flex gap-1.5 flex-wrap mb-3">
          {Object.entries(CATEGORY_META).map(([key, meta]) => (
            <button key={key} onClick={() => setCategory(key)} className="px-3 py-1.5 rounded-full text-[12px] font-semibold"
              style={{ WebkitAppearance: "none", backgroundColor: category === key ? meta.color : "white", color: category === key ? "white" : meta.color }}>
              {meta.label}
            </button>
          ))}
        </div>
      </div>
      <input placeholder="Name (e.g. Advil, Sensory break)" value={title} onChange={(e) => setTitle(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-2 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />
      <input placeholder="Details (e.g. 5 mL)" value={subtitle} onChange={(e) => setSubtitle(e.target.value)}
        className="w-full text-[14px] px-3 py-2 rounded-xl mb-3 text-[#3A4048]" style={{ border: "1px solid #DCEAF5", WebkitAppearance: "none" }} />

      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8A94A0] mb-1.5">Repeats</p>
      <div className="flex gap-1.5 mb-2">
        <button onClick={() => setTimingModel("scheduled")} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ WebkitAppearance: "none", backgroundColor: timingModel === "scheduled" ? "#4A7FAE" : "white", color: timingModel === "scheduled" ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
          On a schedule
        </button>
        <button onClick={() => setTimingModel("asNeeded")} className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ WebkitAppearance: "none", backgroundColor: timingModel === "asNeeded" ? "#4A7FAE" : "white", color: timingModel === "asNeeded" ? "white" : "#4A7FAE", border: "1px solid #DCEAF5" }}>
          As needed
        </button>
      </div>
      {timingModel === "scheduled" ? (
        <div className="flex items-center gap-2 text-[13px] text-[#3A4048] mb-1 flex-wrap">
          Every
          <input type="number" min="1" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} placeholder="?" required
            className="w-16 text-[13px] px-2 py-1 rounded-lg text-center" style={{ border: `1px solid ${intervalHours ? "#DCEAF5" : "#E2B7AE"}`, WebkitAppearance: "none" }} />
          <UnitToggle unit={intervalUnit} setUnit={setIntervalUnit} />
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-[#3A4048] mb-1 flex-wrap">
          Wait at least
          <input type="number" min="1" value={minGapHours} onChange={(e) => setMinGapHours(e.target.value)} placeholder="?" required
            className="w-16 text-[13px] px-2 py-1 rounded-lg text-center" style={{ border: `1px solid ${minGapHours ? "#DCEAF5" : "#E2B7AE"}`, WebkitAppearance: "none" }} />
          <UnitToggle unit={minGapUnit} setUnit={setMinGapUnit} />
          <span>before next</span>
        </div>
      )}
      <p className="text-[11px] text-[#8A94A0] mt-2 mb-3 leading-relaxed">
        Enter the interval from your child's doctor, pharmacist, or the medication label — this app never sets or suggests a timing value.
        It'll start out marked "ready," since you haven't actually given it yet through this app.
      </p>
      <div className="flex gap-2">
        <button onClick={submit} disabled={!canSubmit} className="flex-1 rounded-xl py-2.5 font-semibold text-[14px]"
          style={{ backgroundColor: canSubmit ? "#4A7FAE" : "#C4CDD6", color: "white", WebkitAppearance: "none" }}>
          Create
        </button>
        <button onClick={onCancel} className="rounded-xl py-2.5 px-4 font-semibold text-[14px]" style={{ backgroundColor: "white", color: "#8A94A0", WebkitAppearance: "none" }}>Cancel</button>
      </div>
    </div>
  );
}
