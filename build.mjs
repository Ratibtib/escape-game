#!/usr/bin/env node
/**
 * build.mjs — Génère un site déployable à partir d'UN moteur + N configs de jeu.
 *
 *   Source :
 *     engine/index.html        ← le moteur (seule chose à maintenir)
 *     engine/sw.template.js     ← gabarit du service worker
 *     assets/                   ← médias master (audio, icônes…)
 *     games/<slug>/config.json  ← un fichier par jeu (exporté depuis admin.html)
 *
 *   Sortie (à publier sur GitHub Pages) :
 *     docs/index.html           ← page d'accueil listant les jeux
 *     docs/<slug>/index.html    ← moteur tamponné (fallback = config du jeu)
 *     docs/<slug>/config.json   ← contenu du jeu
 *     docs/<slug>/manifest.json ← généré depuis le branding → app installable
 *     docs/<slug>/sw.js         ← service worker scoppé au jeu
 *     docs/<slug>/<assets>      ← uniquement les médias utilisés par ce jeu
 *
 *   Lancer :  node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = dirname(new URL(import.meta.url).pathname);
const ENGINE = readFileSync(join(ROOT, 'engine/index.html'), 'utf8');
const SW_TPL = readFileSync(join(ROOT, 'engine/sw.template.js'), 'utf8');
const OUT = join(ROOT, 'docs');

// Médias toujours requis par le moteur (audio d'ambiance, avatar, icônes PWA)
const ENGINE_ASSETS = [
  'Fouras.m4a', 'intro3.m4a', 'melody.wav',
  'icons/avatar.png', 'icons/fin.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
// CDN externes (mis en cache offline par le SW)
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

function injectEmbeddedConfig(engineHtml, config) {
  // Remplace la copie de secours embarquée par la config du jeu courant.
  const marker = 'const EMBEDDED_CONFIG = ';
  const start = engineHtml.indexOf(marker);
  const end = engineHtml.indexOf(';\nlet GAME_CONFIG');
  if (start === -1 || end === -1) {
    console.warn('  ⚠ marqueur EMBEDDED_CONFIG introuvable — fallback laissé tel quel');
    return engineHtml;
  }
  return engineHtml.slice(0, start + marker.length) + JSON.stringify(config) + engineHtml.slice(end);
}

function buildManifest(config) {
  const b = config.branding || {}, m = config.meta || {};
  const short = (b.logo || m.name || 'Escape').slice(0, 12);
  return {
    name: b.docTitle || m.name || 'Escape Game',
    short_name: short,
    description: m.note || b.subtitle || 'Escape game immersif',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: b.backgroundColor || '#0a0a0f',
    theme_color: b.themeColor || '#0a0a0f',
    icons: [
      { src: b.appIcon192 || 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: b.appIcon512 || 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

function configAssets(config) {
  const refs = new Set();
  for (const e of config.enigmas || []) {
    for (const k of ['image', 'image2']) if (e[k] && !/^https?:/.test(e[k])) refs.add(e[k]);
  }
  const av = (config.branding || {}).avatar;
  if (av && !/^https?:/.test(av)) refs.add(av);
  for (const ic of [(config.branding||{}).appIcon192, (config.branding||{}).appIcon512]) if (ic && !/^https?:/.test(ic)) refs.add(ic);
  return refs;
}

function copyAsset(rel, destDir) {
  const src = join(ROOT, 'assets', rel);
  if (!existsSync(src)) { console.warn(`  ⚠ asset manquant : ${rel}`); return; }
  const dest = join(destDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function buildGame(slug) {
  const cfgPath = join(ROOT, 'games', slug, 'config.json');
  if (!existsSync(cfgPath)) return null;
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const destDir = join(OUT, slug);
  mkdirSync(destDir, { recursive: true });

  // index.html (moteur + fallback = config du jeu)
  writeFileSync(join(destDir, 'index.html'), injectEmbeddedConfig(ENGINE, config));
  // config.json
  writeFileSync(join(destDir, 'config.json'), JSON.stringify(config, null, 2));
  // manifest.json
  writeFileSync(join(destDir, 'manifest.json'), JSON.stringify(buildManifest(config), null, 2));

  // assets (moteur + spécifiques au jeu, sans doublon)
  const assets = new Set([...ENGINE_ASSETS, ...configAssets(config)]);
  assets.forEach(a => copyAsset(a, destDir));

  // service worker scoppé
  const ver = (config.meta && config.meta.version) || 1;
  const cacheName = `${slug}-v${ver}`;
  const swAssets = ['./', './index.html', './config.json', './manifest.json',
                    ...[...assets].map(a => './' + a), ...CDN];
  writeFileSync(join(destDir, 'sw.js'),
    SW_TPL.replace('__CACHE_NAME__', cacheName).replace('__ASSETS__', JSON.stringify(swAssets, null, 2)));

  const m = config.meta || {}, b = config.branding || {};
  return { slug, name: m.name || slug, client: m.client || '', version: ver,
           enigmas: (config.enigmas||[]).length, logo: b.logo || '' };
}

function landingPage(games) {
  const cards = games.map(g => `
    <a class="card" href="./${g.slug}/">
      <div class="v">v${g.version}</div>
      <h2>${esc(g.name)}</h2>
      <div class="client">${esc(g.client || 'sans client')}</div>
      <div class="meta">${g.enigmas} énigmes</div>
      <div class="go">Ouvrir →</div>
    </a>`).join('');
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Escape Engine — Catalogue</title><style>
:root{--bg:#0a0a0f;--card:#15151f;--border:#262635;--text:#e9e9f2;--dim:#8a8aa0;--accent:#00e0d0;--mono:ui-monospace,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;padding:44px 22px;min-height:100vh}
.wrap{max-width:920px;margin:0 auto}.eyebrow{font-family:var(--mono);font-size:.62rem;letter-spacing:2px;text-transform:uppercase;color:#5a5a70;margin-bottom:8px}
h1{font-size:1.7rem;margin-bottom:6px}.sub{color:var(--dim);margin-bottom:30px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:15px}
.card{display:block;background:linear-gradient(165deg,#1b1b27,#15151f);border:1px solid var(--border);border-radius:14px;padding:20px;text-decoration:none;color:inherit;position:relative;transition:.18s}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card .v{position:absolute;top:16px;right:16px;font-family:var(--mono);font-size:.6rem;color:var(--accent);border:1px solid rgba(0,224,208,.2);padding:2px 7px;border-radius:5px}
.card h2{font-size:1.05rem;margin-bottom:5px;padding-right:42px}.card .client{font-family:var(--mono);font-size:.64rem;color:var(--dim);margin-bottom:16px}
.card .meta{font-size:.74rem;color:var(--dim);margin-bottom:14px}.card .go{font-size:.78rem;color:var(--accent);font-weight:600}
</style></head><body><div class="wrap"><div class="eyebrow">Escape Engine</div>
<h1>Catalogue des jeux</h1><div class="sub">${games.length} jeu(x) déployé(s).</div>
<div class="grid">${cards}</div></div></body></html>`;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ── run ──
console.log('⚙  Build escape-engine');
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const slugs = readdirSync(join(ROOT, 'games')).filter(s => existsSync(join(ROOT, 'games', s, 'config.json')));
const built = [];
for (const slug of slugs) {
  const r = buildGame(slug);
  if (r) { built.push(r); console.log(`  ✓ ${slug.padEnd(16)} "${r.name}" — ${r.enigmas} énigmes → docs/${slug}/`); }
}
writeFileSync(join(OUT, 'index.html'), landingPage(built));
// .nojekyll pour que GitHub Pages serve tout tel quel
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`\n✅ ${built.length} jeu(x) → docs/  (publier le dossier docs/ sur GitHub Pages)`);
