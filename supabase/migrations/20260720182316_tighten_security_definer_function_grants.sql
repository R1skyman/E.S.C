-- These are correctly-scoped (each keys off auth.uid()/auth.email(), never a
-- client-supplied identity), but the linter is right that they're broader than
-- they need to be. get_invite_info is the one exception that genuinely needs
-- anon access, since the invite-preview screen shows "You've been invited to X"
-- before the person has logged in. Everything else only ever makes sense for a
-- signed-in user, so restrict to 'authenticated'.
--
-- Backfilled into source control after the fact -- this was applied directly
-- to the live project and was missing from this repo's migration history.
revoke execute on function public.accept_invite(uuid, text, text) from anon;
revoke execute on function public.create_household(text, text, text) from anon;
revoke execute on function public.get_my_pending_invites() from anon;
revoke execute on function public.is_household_editor(uuid) from public;
revoke execute on function public.is_household_member(uuid) from public;
revoke execute on function public.is_household_owner(uuid) from public;
grant execute on function public.is_household_editor(uuid) to authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.is_household_owner(uuid) to authenticated;
