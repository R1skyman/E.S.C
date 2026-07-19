-- Real invite delivery/acceptance flow.
--
-- Two new RPCs, both narrowly scoped:
--
-- get_invite_info(invite_id) — lets an anonymous visitor who already possesses a specific
-- invite's secret id (from the emailed link) see who it's for and whether it's still valid,
-- without granting any broader access to household_invites. Anonymous SELECT on the base
-- table stays blocked; this is the one sanctioned way to read a single invite pre-auth.
--
-- get_my_pending_invites() — lets an already-authenticated user list invites addressed to
-- their own account email, across every household, not just ones scoped by a link they
-- happen to have. This is what surfaces a pending invite for someone who logged in normally
-- (no link) instead of leaving them stuck on "create your own household".

alter table public.household_invites
  add column expires_at timestamptz not null default (now() + interval '7 days');

create or replace function public.get_invite_info(p_invite_id uuid)
returns table(household_name text, relation text, role text, email text, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  inv public.household_invites;
  hh_name text;
begin
  select * into inv from public.household_invites where id = p_invite_id;
  if inv is null then
    return query select null::text, null::text, null::text, null::text, 'not_found'::text;
    return;
  end if;
  select h.name into hh_name from public.households h where h.id = inv.household_id;
  if inv.expires_at < now() then
    return query select hh_name, inv.relation, inv.role, inv.email, 'expired'::text;
    return;
  end if;
  return query select hh_name, inv.relation, inv.role, inv.email, 'pending'::text;
end;
$$;
revoke all on function public.get_invite_info(uuid) from public;
grant execute on function public.get_invite_info(uuid) to anon, authenticated;

create or replace function public.get_my_pending_invites()
returns table(id uuid, household_id uuid, household_name text, relation text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.household_id, h.name, i.relation, i.role
  from public.household_invites i
  join public.households h on h.id = i.household_id
  where lower(i.email) = lower(auth.email()) and i.expires_at >= now();
$$;
revoke all on function public.get_my_pending_invites() from public;
grant execute on function public.get_my_pending_invites() to authenticated;

-- Redefine accept_invite to also reject an expired invite — the original version (see
-- 20260718120000_init_schema.sql) only checked the email match, not expiry.
create or replace function public.accept_invite(p_invite_id uuid, p_member_name text, p_member_initials text)
returns public.household_members
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.household_invites;
  new_member public.household_members;
  acct_email text := auth.email();
begin
  select * into inv from public.household_invites where id = p_invite_id;
  if inv is null then
    raise exception 'Invite not found';
  end if;
  if inv.expires_at < now() then
    raise exception 'This invite has expired';
  end if;
  if acct_email is null or lower(inv.email) <> lower(acct_email) then
    raise exception 'This invite was not sent to your account email';
  end if;
  insert into public.household_members (household_id, user_id, name, initials, role, relation)
    values (inv.household_id, auth.uid(), p_member_name, p_member_initials, inv.role, inv.relation)
    returning * into new_member;
  delete from public.household_invites where id = p_invite_id;
  return new_member;
end;
$$;
revoke all on function public.accept_invite(uuid, text, text) from public;
grant execute on function public.accept_invite(uuid, text, text) to authenticated;
