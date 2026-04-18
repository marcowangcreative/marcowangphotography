#!/usr/bin/env node
// Runs during `vercel build`. For each gallery-*.html file:
//   - replaces the .vendor-credits footer with fresh credits from Supabase
//   - replaces the .related-weddings strip with curated cross-links
//   - refreshes <title>, <meta name="description">, OG tags, JSON-LD
// Idempotent — safe to re-run. Silently skips slugs that don't exist in the DB.

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.warn('[build-galleries] Supabase env missing — skipping.');
  process.exit(0);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// ---- data fetch ---------------------------------------------------
async function fetchWedding(slug) {
  const { data: wedding, error } = await db
    .from('weddings')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!wedding) return null;

  const { data: credits } = await db
    .from('v_gallery_credits')
    .select('*')
    .eq('wedding_slug', slug);

  const { data: relatedLinks } = await db
    .from('wedding_related')
    .select('sort_order, related:related_wedding_id(slug, display_name, venue_display, hero_image_url, image_folder)')
    .eq('wedding_id', wedding.id)
    .order('sort_order');

  return {
    wedding,
    credits: credits || [],
    related: (relatedLinks || []).map((r) => r.related).filter(Boolean)
  };
}

// ---- HTML fragments -----------------------------------------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

function renderCredits(credits) {
  if (!credits.length) return '';
  const rows = credits.map((c) => {
    const link = c.website
      ? `<a href="${esc(c.website)}" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:none;">${esc(c.display_name)}</a>`
      : esc(c.display_name);
    return `  <p>${esc(c.display_role)}: ${link}</p>`;
  }).join('\n');
  return `<div class="vendor-credits rv" style="padding: clamp(60px, 8vw, 100px) 48px; text-align:left; border-top:1px solid var(--border); font-family:var(--sans); font-size:0.6rem; letter-spacing:0.3em; text-transform:uppercase; color:var(--muted); line-height:2.5; max-width:600px; margin: 0 auto;">
${rows}
</div>`;
}

function renderRelated(related) {
  if (!related.length) return '';
  const cards = related.map((r) => {
    const hero = r.hero_image_url
      || (r.image_folder ? `${r.image_folder}/hero-1.jpg` : '');
    return `    <a href="gallery-${esc(r.slug)}.html" style="text-decoration:none; color:var(--ink); flex:1; min-width:200px; max-width:300px;">
      <img src="${esc(hero)}" alt="${esc(r.display_name)} wedding" style="width:100%; aspect-ratio:3/2; object-fit:cover; margin-bottom:12px;" loading="lazy">
      <span style="font-family:var(--serif); font-style:italic; font-size:1.1rem;">${esc(r.display_name)}</span><br>
      <span style="font-family:var(--sans); font-size:0.5rem; letter-spacing:0.2em; text-transform:uppercase; color:var(--muted);">${esc(r.venue_display || '')}</span>
    </a>`;
  }).join('\n');
  return `<section class="related-weddings rv" style="padding: 60px 48px 72px; text-align:center;">
  <p style="font-family:var(--sans); font-size:0.6rem; font-weight:600; letter-spacing:0.35em; text-transform:uppercase; color:var(--muted); margin-bottom:36px;">More Love Stories</p>
  <div style="display:flex; gap:24px; justify-content:center; flex-wrap:wrap; max-width:800px; margin:0 auto;">
${cards}
  </div>
</section>`;
}

// ---- rewrite ------------------------------------------------------
async function rewriteGallery(slug, filePath) {
  const payload = await fetchWedding(slug);
  if (!payload) {
    console.log(`  · gallery-${slug}: no DB row — leaving as-is`);
    return false;
  }
  const { wedding, credits, related } = payload;
  const html = await readFile(filePath, 'utf8');
  const $ = cheerio.load(html, { decodeEntities: false });

  // Replace vendor credits block
  const creditsEl = $('.vendor-credits');
  if (creditsEl.length && credits.length) {
    creditsEl.replaceWith(renderCredits(credits));
  }

  // Replace related weddings block
  const relatedEl = $('.related-weddings');
  if (relatedEl.length && related.length) {
    relatedEl.replaceWith(renderRelated(related));
  }

  // Refresh meta (only if DB has values — don't clobber hand-authored)
  if (wedding.meta_description) {
    $('meta[name="description"]').attr('content', wedding.meta_description);
    $('meta[property="og:description"]').attr('content', wedding.meta_description);
    $('meta[name="twitter:description"]').attr('content', wedding.meta_description);
  }
  if (wedding.hero_image_url) {
    $('meta[property="og:image"]').attr('content', wedding.hero_image_url);
    $('meta[name="twitter:image"]').attr('content', wedding.hero_image_url);
  }

  await writeFile(filePath, $.html());
  console.log(`  ✓ gallery-${slug}: ${credits.length} credits, ${related.length} related`);
  return true;
}

async function run() {
  const files = (await readdir(ROOT)).filter((f) => /^gallery-[a-z0-9-]+\.html$/.test(f));
  console.log(`[build-galleries] processing ${files.length} gallery files`);
  let touched = 0;
  for (const f of files) {
    const slug = f.replace(/^gallery-|\.html$/g, '');
    try {
      if (await rewriteGallery(slug, join(ROOT, f))) touched++;
    } catch (e) {
      console.error(`  ✗ gallery-${slug}:`, e.message);
    }
  }
  console.log(`[build-galleries] updated ${touched} / ${files.length} files`);
}

run().catch((e) => { console.error(e); process.exit(1); });
