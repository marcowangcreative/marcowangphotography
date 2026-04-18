#!/usr/bin/env node
// One-time: parse existing gallery-*.html files, extract couple name,
// venue, vendors, related-weddings, press mentions; upsert into Supabase.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-from-html.mjs
//
// Idempotent: re-running updates rather than duplicates.

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// ---- slug helpers -------------------------------------------------
const slugify = (s) =>
  (s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Rough category guess from the credit label.
const categorizeRole = (role) => {
  const r = role.toLowerCase();
  if (/photograph/.test(r)) return 'photographer';
  if (/plann?er/.test(r)) return 'planner';
  if (/video|film/.test(r)) return 'videographer';
  if (/florist|flower/.test(r)) return 'florist';
  if (/venue/.test(r)) return 'venue';
  if (/hair/.test(r)) return 'hair';
  if (/makeup|make-up/.test(r)) return 'makeup';
  if (/hmua|beauty/.test(r)) return 'hmua';
  if (/dj/.test(r)) return 'dj';
  if (/band|music/.test(r)) return 'band';
  if (/officiant/.test(r)) return 'officiant';
  if (/cater/.test(r)) return 'caterer';
  if (/stationery|paper|invitation/.test(r)) return 'stationery';
  if (/cake/.test(r)) return 'cake';
  if (/rental/.test(r)) return 'rentals';
  if (/transport|car/.test(r)) return 'transport';
  return 'other';
};

// Heuristic: split "Cakewalk Films" into (credit_name=null, business_name="Cakewalk Films")
//            "Shannon Patak" into (credit_name="Shannon Patak", business_name=null)
// Detects personal names when string has exactly two capitalized tokens.
const splitNameParts = (full) => {
  const t = (full || '').trim();
  const tokens = t.split(/\s+/);
  const isPersonalName =
    tokens.length === 2 &&
    tokens.every((w) => /^[A-Z][a-zA-Z'.-]+$/.test(w));
  return isPersonalName
    ? { credit_name: t, business_name: null }
    : { credit_name: null, business_name: t };
};

// ---- extraction ---------------------------------------------------
function extract(slug, html) {
  const $ = cheerio.load(html);

  const title = $('title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const ogImage = $('meta[property="og:image"]').attr('content') || '';

  // Couple names from filename or first line of hero
  const heroName = $('.gallery-hero-overlay span').last().text().trim();
  // fallbacks
  const hero = {
    subtitle: $('.gallery-hero-overlay span').first().text().trim(),
    headline: $('.gallery-hero-overlay h1').text().trim(),
    location: heroName
  };

  // Parse "Kirby & Chase · The Houstonian Hotel, Houston, TX"
  const parts = heroName.split('·').map((p) => p.trim());
  const couplePart = parts[0] || '';
  const venuePart = parts[1] || '';

  // couple
  const [p1, p2] = couplePart.split('&').map((s) => s.trim());
  const split = (full) => {
    if (!full) return { first: null, last: null };
    const toks = full.split(/\s+/);
    return { first: toks[0] || null, last: toks.slice(1).join(' ') || null };
  };

  // vendor credits
  const vendors = [];
  $('.vendor-credits p').each((i, el) => {
    const text = $(el).text().trim();
    const m = text.match(/^([^:]+):\s*(.+)$/);
    if (!m) return;
    const role = m[1].trim();
    const name = m[2].trim().replace(/\s+/g, ' ');
    const href = $(el).find('a').attr('href') || null;
    vendors.push({ role, name, website: href, credit_order: (i + 1) * 10 });
  });

  // related weddings (slugs only; we'll link after all rows exist)
  const related = [];
  $('.related-weddings a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/gallery-([^.]+)\.html/);
    if (m) related.push({ slug: m[1], sort_order: (i + 1) * 10 });
  });

  // Guess image folder from hero image
  const heroImg = $('.ds-opening-sequence img').first().attr('src') || '';
  const imageFolder = heroImg.split('/')[0] || null;

  // Pick out press mentions (NYT etc.)
  const press = [];
  $('.hero-nyt-badge img').each((_, el) => {
    const alt = $(el).attr('alt') || '';
    if (alt) press.push({ publication: alt, badge_image: $(el).attr('src') || null });
  });

  // JSON-LD date
  let eventDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const d = JSON.parse($(el).html() || '{}');
      if (d.datePublished && !eventDate) eventDate = d.datePublished.slice(0, 10);
    } catch {}
  });

  return {
    slug,
    title,
    meta_description: metaDesc,
    hero_image_url: ogImage || null,
    display_headline: hero.subtitle || null,
    display_subhead: hero.headline || null,
    venue_display: venuePart || null,
    event_date: eventDate,
    image_folder: imageFolder,
    partner1: split(p1),
    partner2: split(p2),
    vendors,
    related,
    press_mentions: press
  };
}

// ---- upsert -------------------------------------------------------
async function upsertVendor(v) {
  const slug = slugify(v.name);
  const { credit_name, business_name } = splitNameParts(v.name);
  const { data, error } = await db.from('vendors').upsert({
    slug,
    name: v.name,
    credit_name,
    business_name,
    category: categorizeRole(v.role),
    website: v.website
  }, { onConflict: 'slug' }).select().single();
  if (error) throw error;
  return data;
}

async function upsertWedding(w) {
  const row = {
    slug: w.slug,
    partner1_first: w.partner1.first,
    partner1_last: w.partner1.last,
    partner2_first: w.partner2.first,
    partner2_last: w.partner2.last,
    event_date: w.event_date,
    image_folder: w.image_folder,
    hero_image_url: w.hero_image_url,
    display_headline: w.display_headline,
    display_subhead: w.display_subhead,
    venue_display: w.venue_display,
    meta_description: w.meta_description,
    press_mentions: w.press_mentions,
    gallery_url: `/gallery-${w.slug}`,
    status: 'delivered',
    gallery_published_at: w.event_date ? new Date(w.event_date).toISOString() : new Date().toISOString()
  };
  const { data, error } = await db.from('weddings').upsert(row, { onConflict: 'slug' }).select().single();
  if (error) throw error;
  return data;
}

async function run() {
  const files = (await readdir(ROOT)).filter((f) => /^gallery-[a-z0-9-]+\.html$/.test(f));
  console.log(`Found ${files.length} gallery files`);

  const parsed = [];
  for (const f of files) {
    const slug = f.replace(/^gallery-|\.html$/g, '');
    const html = await readFile(join(ROOT, f), 'utf8');
    try {
      parsed.push(extract(slug, html));
      console.log(`  parsed gallery-${slug}`);
    } catch (e) {
      console.error(`  ✗ ${slug}:`, e.message);
    }
  }

  // 1. upsert all weddings first (so FK lookups work)
  const bySlug = new Map();
  for (const w of parsed) {
    const row = await upsertWedding(w);
    bySlug.set(w.slug, row);
    console.log(`  ✓ wedding ${w.slug} → ${row.id}`);
  }

  // 2. vendors and join rows
  for (const w of parsed) {
    const weddingRow = bySlug.get(w.slug);
    if (!weddingRow) continue;
    for (const v of w.vendors) {
      const vendorRow = await upsertVendor(v);
      const { error } = await db.from('wedding_vendors').upsert({
        wedding_id: weddingRow.id,
        vendor_id: vendorRow.id,
        role: v.role,
        credit_order: v.credit_order
      }, { onConflict: 'wedding_id,vendor_id,role' });
      if (error) console.error(`  ✗ wv ${w.slug}/${v.role}:`, error.message);
    }
    console.log(`  ✓ ${w.vendors.length} vendors linked to ${w.slug}`);
  }

  // 3. related weddings (both sides must exist)
  for (const w of parsed) {
    const weddingRow = bySlug.get(w.slug);
    if (!weddingRow) continue;
    for (const r of w.related) {
      const relRow = bySlug.get(r.slug);
      if (!relRow) continue;
      await db.from('wedding_related').upsert({
        wedding_id: weddingRow.id,
        related_wedding_id: relRow.id,
        sort_order: r.sort_order
      }, { onConflict: 'wedding_id,related_wedding_id' });
    }
  }

  console.log('\nBackfill complete.');
}

run().catch((e) => { console.error(e); process.exit(1); });
