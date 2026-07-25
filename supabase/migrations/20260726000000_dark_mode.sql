-- Per-account dark mode preference, toggled from Settings > Accessibility, same pattern
-- as read_aloud.

alter table public.user_settings add column dark_mode boolean not null default false;
