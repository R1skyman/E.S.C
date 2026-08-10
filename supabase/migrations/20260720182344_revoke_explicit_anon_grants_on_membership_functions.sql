-- These had a separate explicit grant to anon on top of the PUBLIC grant
-- revoked in the previous migration; revoking from PUBLIC alone didn't remove
-- this one. Only 'authenticated' should be able to call these.
--
-- Backfilled into source control after the fact -- this was applied directly
-- to the live project and was missing from this repo's migration history.
revoke execute on function public.is_household_editor(uuid) from anon;
revoke execute on function public.is_household_member(uuid) from anon;
revoke execute on function public.is_household_owner(uuid) from anon;
