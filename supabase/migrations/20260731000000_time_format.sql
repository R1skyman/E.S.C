-- Per-account 12h/24h time display preference, toggled from Settings > Accessibility
-- next to Dark Mode, same pattern as read_aloud/dark_mode.

alter table public.user_settings
  add column time_format text not null default '12h' check (time_format in ('12h', '24h'));
