-- Weddings, vendors, venues, and the data that flows between the
-- planner tool, the website, and (eventually) the Wedding Team Portal.
-- Run once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ============================================================
-- VENDORS (shared across many weddings)
-- ============================================================
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,                          -- internal canonical name
  credit_name text,                            -- what appears on gallery credits ("Shannon Patak")
  business_name text,                          -- parent business ("Keely Thorne Events")
  category text not null,                      -- planner|hmua|makeup|hair|florist|dj|band|officiant|caterer|videographer|stationery|rentals|cake|transport|other
  phone text,
  email text,
  website text,
  instagram text,
  city text,
  bio text,
  profile_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vendors_category_idx on public.vendors (category);
create index vendors_published_idx on public.vendors (profile_published) where profile_published;

-- ============================================================
-- VENUES (shared across many weddings)
-- ============================================================
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  address text,
  city text,
  region text,
  country text,
  lat numeric(9,6),
  lng numeric(9,6),
  maps_url text,
  website text,
  instagram text,
  notes text,
  profile_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- CREW MEMBERS (Marco's own team)
-- ============================================================
create table public.crew_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text,
  phone text,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- WEDDINGS (the main record)
-- ============================================================
create table public.weddings (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,                   -- 'kc' → /gallery-kc
  partner1_first text,
  partner1_last text,
  partner2_first text,
  partner2_last text,
  display_name text generated always as (
    coalesce(partner1_first, '') ||
    case when partner2_first is not null and length(partner2_first) > 0
         then ' & ' || partner2_first else '' end
  ) stored,
  event_date date,
  city text,
  region text,
  country text,
  coverage_start time,
  coverage_end time,
  coverage_hours numeric(4,1),
  status text not null default 'booked',       -- inquiry|booked|completed|delivered|archived
  gallery_url text,                            -- /gallery-kc (clean URL)
  gallery_published_at timestamptz,
  image_folder text,                           -- 'kc-web'
  hero_image_url text,
  display_headline text,                       -- "A Valentine's Weekend Wedding"
  display_subhead text,                        -- "at The Houstonian"
  venue_display text,                          -- "The Houstonian Hotel, Houston, TX"
  meta_description text,
  opening_quote text,
  press_mentions jsonb not null default '[]'::jsonb,   -- [{publication, url, badge_image}]
  planning_notes text,                         -- private markdown (photo-team notes)
  public_blurb text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index weddings_status_idx on public.weddings (status);
create index weddings_date_idx on public.weddings (event_date desc);

-- ============================================================
-- JOIN: weddings ↔ vendors (with per-wedding role + credit settings)
-- ============================================================
create table public.wedding_vendors (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete restrict,
  role text not null,                          -- 'Planner', 'Hair', 'Florist' (this wedding's label)
  label_override text,                         -- display override (rarely needed)
  credit_order integer not null default 100,
  credit_visibility text not null default 'public',  -- public|team_only|private
  primary key (wedding_id, vendor_id, role)
);
create index wv_wedding_idx on public.wedding_vendors (wedding_id);
create index wv_vendor_idx on public.wedding_vendors (vendor_id);

-- ============================================================
-- JOIN: weddings ↔ venues
-- ============================================================
create table public.wedding_venues (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  role text not null,                          -- ceremony|reception|getting_ready|rehearsal|other
  credit_order integer not null default 100,
  primary key (wedding_id, venue_id, role)
);
create index wvn_wedding_idx on public.wedding_venues (wedding_id);

-- ============================================================
-- JOIN: weddings ↔ crew
-- ============================================================
create table public.wedding_crew (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  crew_id uuid not null references public.crew_members(id) on delete restrict,
  role text,
  primary key (wedding_id, crew_id)
);

-- ============================================================
-- JOIN: curated related weddings ("More Love Stories")
-- ============================================================
create table public.wedding_related (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  related_wedding_id uuid not null references public.weddings(id) on delete cascade,
  sort_order integer not null default 100,
  primary key (wedding_id, related_wedding_id),
  check (wedding_id <> related_wedding_id)
);

-- ============================================================
-- Timeline events (per wedding)
-- ============================================================
create table public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  day date,
  start_time time,
  end_time time,
  label text not null,
  note text,
  venue_id uuid references public.venues(id),
  venue_label text,                            -- fallback when no venue record
  sort_order integer,
  created_at timestamptz not null default now()
);
create index te_wedding_idx on public.timeline_events (wedding_id, day, start_time);

-- ============================================================
-- Family / shot list (per wedding)
-- ============================================================
create table public.shot_list (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  description text not null,
  done boolean not null default false,
  sort_order integer
);
create index sl_wedding_idx on public.shot_list (wedding_id);

-- ============================================================
-- updated_at triggers
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger vendors_updated_at before update on public.vendors
  for each row execute function public.set_updated_at();
create trigger venues_updated_at before update on public.venues
  for each row execute function public.set_updated_at();
create trigger weddings_updated_at before update on public.weddings
  for each row execute function public.set_updated_at();

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================
-- Principle: anon can read only what's meant for the public gallery.
-- Everything else requires authenticated writes. The build script uses
-- the service_role key which bypasses RLS.

alter table public.vendors        enable row level security;
alter table public.venues         enable row level security;
alter table public.crew_members   enable row level security;
alter table public.weddings       enable row level security;
alter table public.wedding_vendors enable row level security;
alter table public.wedding_venues  enable row level security;
alter table public.wedding_crew    enable row level security;
alter table public.wedding_related enable row level security;
alter table public.timeline_events enable row level security;
alter table public.shot_list       enable row level security;

-- Helper: is this wedding publicly visible?
create or replace function public.wedding_is_public(w_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.weddings
    where id = w_id
      and status in ('delivered', 'archived')
      and gallery_url is not null
  );
$$;

-- vendors: public read for published profiles; authenticated all
create policy vendors_anon_read on public.vendors
  for select to anon using (profile_published = true);
create policy vendors_auth_all on public.vendors
  for all to authenticated using (true) with check (true);

-- venues: public read for published; authenticated all
create policy venues_anon_read on public.venues
  for select to anon using (profile_published = true);
create policy venues_auth_all on public.venues
  for all to authenticated using (true) with check (true);

-- crew: authenticated only (never public)
create policy crew_auth_all on public.crew_members
  for all to authenticated using (true) with check (true);

-- weddings: public read for delivered/archived with a gallery_url
create policy weddings_anon_read on public.weddings
  for select to anon using (
    status in ('delivered', 'archived') and gallery_url is not null
  );
create policy weddings_auth_all on public.weddings
  for all to authenticated using (true) with check (true);

-- wedding_vendors: public read for public credits on public weddings
create policy wv_anon_read on public.wedding_vendors
  for select to anon using (
    credit_visibility = 'public' and public.wedding_is_public(wedding_id)
  );
create policy wv_auth_all on public.wedding_vendors
  for all to authenticated using (true) with check (true);

-- wedding_venues: public read for public weddings
create policy wvn_anon_read on public.wedding_venues
  for select to anon using (public.wedding_is_public(wedding_id));
create policy wvn_auth_all on public.wedding_venues
  for all to authenticated using (true) with check (true);

-- wedding_related: public read for public weddings
create policy wr_anon_read on public.wedding_related
  for select to anon using (
    public.wedding_is_public(wedding_id) and public.wedding_is_public(related_wedding_id)
  );
create policy wr_auth_all on public.wedding_related
  for all to authenticated using (true) with check (true);

-- wedding_crew / timeline_events / shot_list: authenticated only
create policy wc_auth_all on public.wedding_crew
  for all to authenticated using (true) with check (true);
create policy te_auth_all on public.timeline_events
  for all to authenticated using (true) with check (true);
create policy sl_auth_all on public.shot_list
  for all to authenticated using (true) with check (true);

-- ============================================================
-- Convenience view: gallery credits (flattened, ordered)
-- ============================================================
create or replace view public.v_gallery_credits as
select
  w.slug as wedding_slug,
  wv.role,
  coalesce(wv.label_override, wv.role) as display_role,
  coalesce(v.credit_name, v.business_name, v.name) as display_name,
  v.website,
  v.slug as vendor_slug,
  wv.credit_order
from public.wedding_vendors wv
join public.vendors v on v.id = wv.vendor_id
join public.weddings w on w.id = wv.wedding_id
where wv.credit_visibility = 'public'
  and w.status in ('delivered','archived')
order by w.slug, wv.credit_order, wv.role;

grant select on public.v_gallery_credits to anon, authenticated;
