import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Row <-> app-shape mapping. The app's in-memory shapes (households, care
// items, timeline entries, ...) predate this backend and are left exactly as
// they were when everything lived in window.storage, so the rest of the app
// (every screen component) doesn't need to change — only these mappers and
// the top-level persist*/bootstrap functions in App.jsx do.
// ---------------------------------------------------------------------------

function memberFromRow(row, myUserId) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    initials: row.initials,
    role: row.role,
    relation: row.relation,
    note: row.note || "",
    isYou: row.user_id === myUserId,
  };
}

function inviteFromRow(row) {
  return { id: row.id, email: row.email, relation: row.relation, role: row.role };
}

function childFromRow(row) {
  return { id: row.id, name: row.name, initials: row.initials, age: row.age, bio: row.bio || "" };
}

function careItemFromRow(row) {
  const item = {
    id: row.id, category: row.category, title: row.title, subtitle: row.subtitle || "",
    timingModel: row.timing_model, lastDone: new Date(row.last_done).getTime(),
  };
  if (row.timing_model === "scheduled") item.intervalHours = row.interval_hours;
  else item.minGapHours = row.min_gap_hours;
  return item;
}

function timelineEntryFromRow(row) {
  return { id: row.id, time: row.time, date: row.day_key, category: row.category, title: row.title, subtitle: row.subtitle || "", loggedBy: row.logged_by || "" };
}

function upcomingFromRow(row) {
  return { id: row.id, category: row.category, title: row.title, subtitle: row.subtitle || "", notes: row.notes || "", timestamp: new Date(row.timestamp).getTime(), recurrence: row.recurrence, notified: row.notified };
}

function contactFromRow(row) {
  return { id: row.id, category: row.category, name: row.name, subtitle: row.subtitle || "", phone: row.phone || "", address: row.address || "", url: row.url || "", notes: row.notes || "", childIds: row.child_ids || [] };
}

function settingsFromRow(row) {
  return {
    faceIdAuto: row.face_id_auto, notifyMeds: row.notify_meds, notifyEvents: row.notify_events, notifyChannel: row.notify_channel,
    profile: { firstName: row.first_name || "", lastName: row.last_name || "", email: row.email || "", phone: row.phone || "" },
    categoryColors: row.category_colors || {}, readAloud: row.read_aloud,
  };
}

function throwIfError(error) {
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Bulk fetch — everything bootstrap() needs, in as few round trips as possible.
// ---------------------------------------------------------------------------

export async function fetchHouseholds(myUserId) {
  const { data: households, error: hhErr } = await supabase.from("households").select("*").order("created_at");
  throwIfError(hhErr);
  if (!households || households.length === 0) return [];

  const ids = households.map((h) => h.id);
  const [membersRes, invitesRes, childrenRes] = await Promise.all([
    supabase.from("household_members").select("*").in("household_id", ids),
    supabase.from("household_invites").select("*").in("household_id", ids),
    supabase.from("children").select("*").in("household_id", ids),
  ]);
  throwIfError(membersRes.error);
  throwIfError(invitesRes.error);
  throwIfError(childrenRes.error);

  return households.map((h) => ({
    id: h.id,
    name: h.name,
    members: membersRes.data.filter((m) => m.household_id === h.id).map((m) => memberFromRow(m, myUserId)),
    invites: invitesRes.data.filter((i) => i.household_id === h.id).map(inviteFromRow),
    children: childrenRes.data.filter((c) => c.household_id === h.id).map(childFromRow),
  }));
}

export async function fetchChildData(childIds) {
  const careItems = {}, timeline = {}, upcoming = {};
  for (const cid of childIds) { careItems[cid] = []; timeline[cid] = {}; upcoming[cid] = []; }
  if (childIds.length === 0) return { careItems, timeline, upcoming };

  const [careRes, tlRes, upRes] = await Promise.all([
    supabase.from("care_items").select("*").in("child_id", childIds),
    supabase.from("timeline_entries").select("*").in("child_id", childIds).order("created_at"),
    supabase.from("upcoming_items").select("*").in("child_id", childIds),
  ]);
  throwIfError(careRes.error);
  throwIfError(tlRes.error);
  throwIfError(upRes.error);

  for (const row of careRes.data) careItems[row.child_id].push(careItemFromRow(row));
  for (const row of tlRes.data) {
    const day = timeline[row.child_id][row.day_key] || (timeline[row.child_id][row.day_key] = []);
    day.push(timelineEntryFromRow(row));
  }
  for (const row of upRes.data) upcoming[row.child_id].push(upcomingFromRow(row));
  return { careItems, timeline, upcoming };
}

export async function fetchInfoBank(householdId) {
  const { data, error } = await supabase.from("info_bank_contacts").select("*").eq("household_id", householdId);
  throwIfError(error);
  return (data || []).map(contactFromRow);
}

export async function fetchOrCreateSettings(userId, defaults) {
  const { data, error } = await supabase.from("user_settings").select("*").eq("user_id", userId).maybeSingle();
  throwIfError(error);
  if (data) return settingsFromRow(data);
  const { data: created, error: insErr } = await supabase.from("user_settings").insert({
    user_id: userId, face_id_auto: defaults.faceIdAuto, notify_meds: defaults.notifyMeds, notify_events: defaults.notifyEvents,
    notify_channel: defaults.notifyChannel, first_name: defaults.profile.firstName, last_name: defaults.profile.lastName,
    email: defaults.profile.email, phone: defaults.profile.phone,
  }).select().single();
  throwIfError(insErr);
  return settingsFromRow(created);
}

export async function fetchActiveHouseholdId(userId) {
  const { data, error } = await supabase.from("user_settings").select("active_household_id").eq("user_id", userId).maybeSingle();
  throwIfError(error);
  return data?.active_household_id ?? null;
}

// ---------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------

export async function createHousehold(name, memberName, memberInitials, myUserId) {
  const { data, error } = await supabase.rpc("create_household", { p_name: name, p_member_name: memberName, p_member_initials: memberInitials });
  throwIfError(error);
  // The RPC only returns the household row; fetch the member row it also created so the
  // returned shape has a real id (needed for any later edit/delete of that member).
  const { data: memberRow, error: mErr } = await supabase
    .from("household_members").select("*").eq("household_id", data.id).eq("user_id", myUserId).single();
  throwIfError(mErr);
  return { id: data.id, name: data.name, children: [], members: [memberFromRow(memberRow, myUserId)], invites: [] };
}

export async function updateHouseholdName(id, name) {
  throwIfError((await supabase.from("households").update({ name }).eq("id", id)).error);
}

export async function deleteHouseholdRow(id) {
  throwIfError((await supabase.from("households").delete().eq("id", id)).error);
}

// ---------------------------------------------------------------------------
// Household members / invites
// ---------------------------------------------------------------------------

export async function updateMember(id, patch) {
  const update = {};
  if ("role" in patch) update.role = patch.role;
  if ("note" in patch) update.note = patch.note;
  throwIfError((await supabase.from("household_members").update(update).eq("id", id)).error);
}

export async function deleteMember(id) {
  throwIfError((await supabase.from("household_members").delete().eq("id", id)).error);
}

export async function insertInvite(householdId, invite) {
  const row = { id: invite.id, household_id: householdId, email: invite.email, relation: invite.relation, role: invite.role };
  const { error } = await supabase.from("household_invites").insert(row);
  throwIfError(error);
}

export async function deleteInvite(id) {
  throwIfError((await supabase.from("household_invites").delete().eq("id", id)).error);
}

export async function acceptInviteRpc(inviteId, memberName, memberInitials) {
  const { data, error } = await supabase.rpc("accept_invite", { p_invite_id: inviteId, p_member_name: memberName, p_member_initials: memberInitials });
  throwIfError(error);
  return memberFromRow(data, data.user_id);
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

export async function insertChild(householdId, child) {
  const row = { id: child.id, household_id: householdId, name: child.name, initials: child.initials, age: child.age, bio: child.bio || "" };
  throwIfError((await supabase.from("children").insert(row)).error);
}

export async function updateChild(id, patch) {
  const update = {};
  if ("name" in patch) update.name = patch.name;
  if ("initials" in patch) update.initials = patch.initials;
  if ("age" in patch) update.age = patch.age;
  if ("bio" in patch) update.bio = patch.bio;
  throwIfError((await supabase.from("children").update(update).eq("id", id)).error);
}

export async function deleteChildRow(id) {
  throwIfError((await supabase.from("children").delete().eq("id", id)).error);
}

// ---------------------------------------------------------------------------
// Care items
// ---------------------------------------------------------------------------

export async function replaceCareItems(childId, items) {
  throwIfError((await supabase.from("care_items").delete().eq("child_id", childId)).error);
  if (items.length === 0) return;
  const rows = items.map((item) => ({
    id: item.id, child_id: childId, category: item.category, title: item.title, subtitle: item.subtitle || "",
    timing_model: item.timingModel, last_done: new Date(item.lastDone).toISOString(),
    interval_hours: item.intervalHours ?? null, min_gap_hours: item.minGapHours ?? null,
  }));
  throwIfError((await supabase.from("care_items").upsert(rows)).error);
}

// ---------------------------------------------------------------------------
// Timeline entries
// ---------------------------------------------------------------------------

export async function replaceTimelineDay(childId, dayKey, entries) {
  throwIfError((await supabase.from("timeline_entries").delete().eq("child_id", childId).eq("day_key", dayKey)).error);
  if (entries.length === 0) return;
  const rows = entries.map((e) => ({
    id: e.id, child_id: childId, day_key: dayKey, time: e.time, category: e.category, title: e.title,
    subtitle: e.subtitle || "", logged_by: e.loggedBy || "",
  }));
  throwIfError((await supabase.from("timeline_entries").upsert(rows)).error);
}

// ---------------------------------------------------------------------------
// Upcoming items
// ---------------------------------------------------------------------------

export async function replaceUpcomingItems(childId, items) {
  throwIfError((await supabase.from("upcoming_items").delete().eq("child_id", childId)).error);
  if (items.length === 0) return;
  const rows = items.map((item) => ({
    id: item.id, child_id: childId, category: item.category, title: item.title, subtitle: item.subtitle || "",
    notes: item.notes || "", timestamp: new Date(item.timestamp).toISOString(), recurrence: item.recurrence || "none",
    notified: !!item.notified,
  }));
  throwIfError((await supabase.from("upcoming_items").upsert(rows)).error);
}

// ---------------------------------------------------------------------------
// Info Bank
// ---------------------------------------------------------------------------

export async function replaceInfoBank(householdId, contacts) {
  throwIfError((await supabase.from("info_bank_contacts").delete().eq("household_id", householdId)).error);
  if (contacts.length === 0) return;
  const rows = contacts.map((c) => ({
    id: c.id, household_id: householdId, category: c.category, name: c.name, subtitle: c.subtitle || "",
    phone: c.phone || "", address: c.address || "", url: c.url || "", notes: c.notes || "", child_ids: c.childIds || [],
  }));
  throwIfError((await supabase.from("info_bank_contacts").upsert(rows)).error);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveSettingsRow(userId, settings) {
  const row = {
    face_id_auto: settings.faceIdAuto, notify_meds: settings.notifyMeds, notify_events: settings.notifyEvents,
    notify_channel: settings.notifyChannel, first_name: settings.profile.firstName, last_name: settings.profile.lastName,
    email: settings.profile.email, phone: settings.profile.phone, category_colors: settings.categoryColors || {},
    read_aloud: !!settings.readAloud,
  };
  throwIfError((await supabase.from("user_settings").update(row).eq("user_id", userId)).error);
}

export async function saveActiveHouseholdId(userId, householdId) {
  throwIfError((await supabase.from("user_settings").update({ active_household_id: householdId }).eq("user_id", userId)).error);
}
