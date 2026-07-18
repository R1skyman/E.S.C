-- Tandem: household care-tracking schema.
-- Every table is scoped to a household via RLS; a user can only read/write
-- rows belonging to a household they're a member of, and only mutate them if
-- their role in that household is 'owner' or 'full' (matching ROLE_META in
-- src/constants.js — 'view' members are read-only everywhere).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'New Household',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  initials text not null default '',
  role text not null check (role in ('owner', 'full', 'view')),
  relation text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (household_id, user_id)
);

create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  email text not null,
  relation text not null default 'Caregiver',
  role text not null check (role in ('owner', 'full', 'view')),
  created_at timestamptz not null default now()
);

create table public.children (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  initials text not null default '',
  age integer not null default 0,
  bio text not null default '',
  created_at timestamptz not null default now()
);

create table public.care_items (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  category text not null,
  title text not null,
  subtitle text not null default '',
  timing_model text not null check (timing_model in ('scheduled', 'asNeeded')),
  last_done timestamptz not null default now(),
  interval_hours numeric,
  min_gap_hours numeric,
  created_at timestamptz not null default now()
);

create table public.timeline_entries (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  day_key text not null,
  time text not null,
  category text not null,
  title text not null,
  subtitle text not null default '',
  logged_by text not null default '',
  created_at timestamptz not null default now()
);
create index timeline_entries_child_day_idx on public.timeline_entries (child_id, day_key);

create table public.upcoming_items (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  category text not null,
  title text not null,
  subtitle text not null default '',
  notes text not null default '',
  timestamp timestamptz not null,
  recurrence text not null default 'none',
  notified boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.info_bank_contacts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  category text not null,
  name text not null,
  subtitle text not null default '',
  phone text not null default '',
  address text not null default '',
  url text not null default '',
  notes text not null default '',
  child_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  face_id_auto boolean not null default false,
  notify_meds boolean not null default true,
  notify_events boolean not null default true,
  notify_channel text not null default 'email',
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone text not null default '',
  category_colors jsonb not null default '{}'::jsonb,
  read_aloud boolean not null default false,
  active_household_id uuid references public.households(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Membership helper functions — SECURITY DEFINER so they can read
-- household_members without recursing back into that table's own RLS.
-- ---------------------------------------------------------------------------

create or replace function public.is_household_member(hh_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hh_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_household_editor(hh_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hh_id and user_id = auth.uid() and role in ('owner', 'full')
  );
$$;

create or replace function public.is_household_owner(hh_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hh_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.children enable row level security;
alter table public.care_items enable row level security;
alter table public.timeline_entries enable row level security;
alter table public.upcoming_items enable row level security;
alter table public.info_bank_contacts enable row level security;
alter table public.user_settings enable row level security;

-- households
create policy "select own households" on public.households
  for select using (public.is_household_member(id));
create policy "insert household as self" on public.households
  for insert with check (created_by = auth.uid());
create policy "update household as editor" on public.households
  for update using (public.is_household_editor(id)) with check (public.is_household_editor(id));
create policy "delete household as owner" on public.households
  for delete using (public.is_household_owner(id));

-- household_members
create policy "select members of own households" on public.household_members
  for select using (public.is_household_member(household_id));
create policy "insert self as member" on public.household_members
  for insert with check (user_id = auth.uid());
create policy "update members as owner" on public.household_members
  for update using (public.is_household_owner(household_id)) with check (public.is_household_owner(household_id));
create policy "delete members as owner" on public.household_members
  for delete using (public.is_household_owner(household_id));

-- household_invites — a user can also see/accept/decline (delete) an invite
-- addressed to their own account email, even before they're a member.
create policy "select invites as member or invitee" on public.household_invites
  for select using (
    public.is_household_member(household_id)
    or lower(email) = lower(auth.email())
  );
create policy "insert invites as editor" on public.household_invites
  for insert with check (public.is_household_editor(household_id));
create policy "delete invites as editor or invitee" on public.household_invites
  for delete using (
    public.is_household_editor(household_id)
    or lower(email) = lower(auth.email())
  );

-- children
create policy "select children of own households" on public.children
  for select using (public.is_household_member(household_id));
create policy "write children as editor" on public.children
  for all using (public.is_household_editor(household_id)) with check (public.is_household_editor(household_id));

-- care_items (scoped through children -> household)
create policy "select care_items of own households" on public.care_items
  for select using (exists (
    select 1 from public.children c where c.id = care_items.child_id and public.is_household_member(c.household_id)
  ));
create policy "write care_items as editor" on public.care_items
  for all using (exists (
    select 1 from public.children c where c.id = care_items.child_id and public.is_household_editor(c.household_id)
  )) with check (exists (
    select 1 from public.children c where c.id = care_items.child_id and public.is_household_editor(c.household_id)
  ));

-- timeline_entries
create policy "select timeline_entries of own households" on public.timeline_entries
  for select using (exists (
    select 1 from public.children c where c.id = timeline_entries.child_id and public.is_household_member(c.household_id)
  ));
create policy "write timeline_entries as editor" on public.timeline_entries
  for all using (exists (
    select 1 from public.children c where c.id = timeline_entries.child_id and public.is_household_editor(c.household_id)
  )) with check (exists (
    select 1 from public.children c where c.id = timeline_entries.child_id and public.is_household_editor(c.household_id)
  ));

-- upcoming_items
create policy "select upcoming_items of own households" on public.upcoming_items
  for select using (exists (
    select 1 from public.children c where c.id = upcoming_items.child_id and public.is_household_member(c.household_id)
  ));
create policy "write upcoming_items as editor" on public.upcoming_items
  for all using (exists (
    select 1 from public.children c where c.id = upcoming_items.child_id and public.is_household_editor(c.household_id)
  )) with check (exists (
    select 1 from public.children c where c.id = upcoming_items.child_id and public.is_household_editor(c.household_id)
  ));

-- info_bank_contacts
create policy "select info_bank_contacts of own households" on public.info_bank_contacts
  for select using (public.is_household_member(household_id));
create policy "write info_bank_contacts as editor" on public.info_bank_contacts
  for all using (public.is_household_editor(household_id)) with check (public.is_household_editor(household_id));

-- user_settings
create policy "manage own settings" on public.user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPCs — atomic operations that would otherwise hit RLS bootstrapping
-- problems (creating a household and your own membership row must happen
-- together) or need a server-side invariant enforced (an invite can only be
-- accepted by the account it was actually sent to).
-- ---------------------------------------------------------------------------

create or replace function public.create_household(p_name text, p_member_name text, p_member_initials text)
returns public.households
language plpgsql
security definer
set search_path = public
as $$
declare
  new_household public.households;
begin
  insert into public.households (name, created_by) values (coalesce(nullif(trim(p_name), ''), 'New Household'), auth.uid())
    returning * into new_household;
  insert into public.household_members (household_id, user_id, name, initials, role, relation)
    values (new_household.id, auth.uid(), p_member_name, p_member_initials, 'owner', 'You');
  return new_household;
end;
$$;
revoke all on function public.create_household(text, text, text) from public;
grant execute on function public.create_household(text, text, text) to authenticated;

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
