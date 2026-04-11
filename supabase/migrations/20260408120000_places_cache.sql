-- Google Places result cache
-- Each uteservering address is looked up at most once per 30 days.
-- name IS NULL means we tried and found no matching Place — still cached
-- so we don't re-query Google for unmatched venues on every map view.

create table if not exists public.places_cache (
  address    text        primary key,
  name       text,                         -- null = no Places match found
  venue_type text,
  rating     float4,
  cached_at  timestamptz not null default now()
);

alter table public.places_cache enable row level security;

-- Cache contains only public venue metadata (names, types, ratings) —
-- no personal data, so anonymous read/write is fine.
create policy "places_cache_select" on public.places_cache
  for select using (true);

create policy "places_cache_insert" on public.places_cache
  for insert with check (true);

create policy "places_cache_update" on public.places_cache
  for update using (true);
