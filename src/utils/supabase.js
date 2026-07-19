import { createClient } from "@supabase/supabase-js";

const REMEMBER_KEY = "escape:rememberMe";

// The "remember me" preference itself always lives in localStorage (it's just a tiny flag, not
// sensitive) — defaults to true so an existing session isn't silently dropped on first load.
export function getRememberMe() {
  try { return window.localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return true; }
}

export function setRememberMe(remember) {
  try { window.localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0"); } catch { /* ignore */ }
}

// The Supabase client is a long-lived singleton, but "remember me" can change on every login —
// so rather than choosing a storage backend once at startup, this reads the current preference
// on every call and reads/writes the session through localStorage (survives closing the browser)
// or sessionStorage (cleared when the tab/browser closes) accordingly.
const dynamicSessionStorage = {
  getItem: (key) => (getRememberMe() ? window.localStorage : window.sessionStorage).getItem(key),
  setItem: (key, value) => (getRememberMe() ? window.localStorage : window.sessionStorage).setItem(key, value),
  removeItem: (key) => (getRememberMe() ? window.localStorage : window.sessionStorage).removeItem(key),
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { storage: dynamicSessionStorage },
});
