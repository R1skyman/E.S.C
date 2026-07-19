// Sends the actual invite email via Resend when someone is invited to a household.
//
// Called from the client right after a household_invites row is inserted
// (see sendInvite in App.jsx). Every read here goes through a Supabase client
// scoped to the CALLING user's own session/RLS — this function only ever sees
// (and can only act on) an invite the caller is themselves an editor of; it's
// not a general-purpose "send arbitrary email" endpoint.
//
// Required secrets (set via `supabase secrets set` or the dashboard):
//   RESEND_API_KEY     - from resend.com
//   SITE_URL           - the deployed app origin, e.g. https://your-app.vercel.app
// Optional:
//   INVITE_FROM_EMAIL  - defaults to Resend's shared test address, which only
//                        delivers to the email on your own Resend account until
//                        you verify a sending domain.
//
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically by the Edge
// Functions runtime - no need to set them.

import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SITE_URL = Deno.env.get("SITE_URL");
const FROM_EMAIL = Deno.env.get("INVITE_FROM_EMAIL") || "onboarding@resend.dev";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ROLE_LABELS: Record<string, string> = { owner: "Owner", full: "Full access", view: "View only" };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured for this function");
    if (!SITE_URL) throw new Error("SITE_URL is not configured for this function");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const { inviteId } = await req.json();
    if (!inviteId) return json({ error: "inviteId is required" }, 400);

    // Scoped to the caller's own session - every query below runs under their RLS, so this
    // can never read or act on an invite/household the caller doesn't have editor access to.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: invite, error: inviteErr } = await userClient
      .from("household_invites")
      .select("id, email, relation, role, expires_at, household_id, households(name)")
      .eq("id", inviteId)
      .single();
    if (inviteErr || !invite) return json({ error: "Invite not found" }, 404);

    const { data: isEditor, error: editorErr } = await userClient.rpc("is_household_editor", { hh_id: invite.household_id });
    if (editorErr || !isEditor) return json({ error: "Not authorized to send this invite" }, 403);

    const { data: userData } = await userClient.auth.getUser();
    const inviterName = userData?.user?.user_metadata?.full_name || userData?.user?.email || "Someone";

    const householdName = (invite.households as { name?: string } | null)?.name || "a household";
    const roleLabel = ROLE_LABELS[invite.role] || invite.role;
    const link = `${SITE_URL}/?invite=${invite.id}`;
    const expiresLabel = new Date(invite.expires_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

    const html = `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #3A4048;">
        <h2 style="color:#3A4048;">You're invited to ${escapeHtml(householdName)}</h2>
        <p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(householdName)}</strong> on Escape as <strong>${escapeHtml(roleLabel)}</strong>.</p>
        <p><a href="${link}" style="display:inline-block; background:#4A7FAE; color:#fff; padding:12px 24px; border-radius:12px; text-decoration:none; font-weight:600;">View invitation</a></p>
        <p style="color:#8A94A0; font-size:13px;">This link expires ${expiresLabel}. If you weren't expecting this, you can ignore this email.</p>
      </div>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Escape <${FROM_EMAIL}>`,
        to: [invite.email],
        subject: `You're invited to join ${householdName}`,
        html,
      }),
    });
    if (!resendRes.ok) {
      const detail = await resendRes.text();
      return json({ error: `Resend API error: ${detail}` }, 502);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
