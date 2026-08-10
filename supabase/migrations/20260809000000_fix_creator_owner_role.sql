-- Data cleanup: two households created on 2026-07-19 (before the household_members
-- direct-insert privilege-escalation hole was closed -- see
-- 20260720182256_close_household_members_insert_privilege_escalation.sql) ended up with
-- their creator's own membership row at role 'full' instead of 'owner'. The client-side
-- code that inserted those rows predates the current create_household/accept_invite RPCs
-- (which have always correctly hardcoded 'owner' for the creator) and no longer exists --
-- this is a one-time fix for the rows it left behind, not an ongoing bug.
update public.household_members m
set role = 'owner'
from public.households h
where m.household_id = h.id
  and m.user_id = h.created_by
  and m.role <> 'owner';
