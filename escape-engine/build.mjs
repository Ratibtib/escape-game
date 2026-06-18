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
const ADMIN = readFileSync(join(ROOT, 'engine/admin.html'), 'utf8');
const THEME_EDITOR = existsSync(join(ROOT, 'engine/theme-editor.html')) ? readFileSync(join(ROOT, 'engine/theme-editor.html'), 'utf8') : null;
const SW_TPL = readFileSync(join(ROOT, 'engine/sw.template.js'), 'utf8');
const OUT = join(ROOT, 'docs');

// Bibliothèque de thèmes (centrale) — facultative
let THEMES = {};
let DEFAULT_THEME_ID = null;
if (existsSync(join(ROOT, 'themes.json'))) {
  try {
    const lib = JSON.parse(readFileSync(join(ROOT, 'themes.json'), 'utf8'));
    (lib.themes || []).forEach(t => { THEMES[t.id] = t; if (!DEFAULT_THEME_ID) DEFAULT_THEME_ID = t.id; });
  } catch (e) { console.warn('  ⚠ themes.json illisible:', e.message); }
}
function resolveTheme(config) {
  const id = config.theme || (config.meta && config.meta.theme);
  return THEMES[id] || THEMES[DEFAULT_THEME_ID] || null;
}
function blendHex(a, b, t = 0.5) {
  const p = h => { h = h.replace('#',''); if (h.length===3) h=h.split('').map(x=>x+x).join(''); return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)); };
  const A=p(a), B=p(b); const m=A.map((v,i)=>Math.round(v+(B[i]-v)*t));
  return '#'+m.map(v=>v.toString(16).padStart(2,'0')).join('');
}
function themeToCss(t) {
  const c = t.colors;
  const a = (hex,suf) => /^#[0-9a-fA-F]{6}$/.test(hex) ? hex+suf : hex;
  return `<style id="theme-override">:root{`+
    `--bg-deep:${c.bg};--bg-card:${c.card};--bg-panel:${blendHex(c.bg,c.card,0.5)};`+
    `--accent:${c.accent};--accent-dim:${a(c.accent,'33')};--accent-glow:${a(c.accent, t.glow?'88':'00')};`+
    `--warn:${c.danger};--warn-dim:${a(c.danger,'33')};--success:${c.ok};--success-dim:${a(c.ok,'33')};`+
    `--gold:${c.hint};--text:${c.text};--text-dim:${c.dim};--border:${c.border};`+
    `--font-display:${t.fonts.display};--font-body:${t.fonts.body};--font-mono:${t.fonts.mono};`+
    `}</style>`;
}

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

function injectAdminConfig(adminHtml, config) {
  // Pré-charge l'admin avec une config (ici un modèle vierge pour l'admin racine).
  const marker = 'const DEFAULT_CONFIG = ';
  const start = adminHtml.indexOf(marker);
  const fmt = adminHtml.indexOf('const FORMATS');
  if (start === -1 || fmt === -1) return adminHtml;
  const semi = adminHtml.lastIndexOf(';', fmt);
  return adminHtml.slice(0, start + marker.length) + JSON.stringify(config) + adminHtml.slice(semi);
}
function blankTemplate() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    meta: { id: '', name: 'Nouveau jeu', client: '', note: '', version: 1, createdAt: now, updatedAt: now },
    branding: { docTitle: 'Nouveau jeu', logo: 'NOUVEAU', subtitle: 'Système de réactivation', codename: '/// NOUVEAU ///', classified: '/// CONFIDENTIEL ///', avatar: 'icons/avatar.png' },
    actBoundaries: [0, 0],
    acts: [],
    enigmas: [],
  };
}

function buildManifest(config, theme) {
  const b = config.branding || {}, m = config.meta || {};
  const short = (b.logo || m.name || 'Escape').slice(0, 12);
  const bg = (theme && theme.colors && theme.colors.bg) || b.backgroundColor || '#0a0a0f';
  return {
    name: b.docTitle || m.name || 'Escape Game',
    short_name: short,
    description: m.note || b.subtitle || 'Escape game immersif',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: bg,
    theme_color: b.themeColor || bg,
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
  // L'identité du jeu = le nom de son dossier (garantit la cohérence éditeur ↔ dossier)
  config.meta = config.meta || {};
  config.meta.id = slug;
  const destDir = join(OUT, slug);
  mkdirSync(destDir, { recursive: true });

  // Thème affecté à ce jeu (depuis themes.json) → injecté dans le moteur
  const theme = resolveTheme(config);
  let engineHtml = injectEmbeddedConfig(ENGINE, config);
  if (theme) engineHtml = engineHtml.replace('</head>', themeToCss(theme) + '\n</head>');

  // index.html (moteur thémé + fallback = config du jeu)
  writeFileSync(join(destDir, 'index.html'), engineHtml);
  // config.json
  writeFileSync(join(destDir, 'config.json'), JSON.stringify(config, null, 2));
  // manifest.json (couleurs issues du thème)
  writeFileSync(join(destDir, 'manifest.json'), JSON.stringify(buildManifest(config, theme), null, 2));

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
           enigmas: (config.enigmas||[]).length, logo: b.logo || '',
           theme: theme ? { name: theme.name, accent: theme.colors.accent, bg: theme.colors.bg } : null };
}

function landingPage(games) {
  const cards = games.map(g => `
    <div class="card">
      <div class="v">v${g.version}</div>
      <h2>${esc(g.name)}</h2>
      <div class="client">${esc(g.client || 'sans client')}</div>
      <div class="meta">${g.enigmas} énigmes${g.theme ? ` · <span class="thm"><i style="background:${g.theme.accent}"></i>${esc(g.theme.name)}</span>` : ''}</div>
      <div class="links">
        <a class="go" href="./${g.slug}/">Ouvrir le jeu →</a>
        <a class="edit" href="./admin.html?config=${g.slug}/config.json">✎ Éditer</a>
      </div>
    </div>`).join('');
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Escape Engine — Catalogue</title><style>
:root{--bg:#0a0a0f;--card:#15151f;--border:#262635;--text:#e9e9f2;--dim:#8a8aa0;--accent:#00e0d0;--mono:ui-monospace,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;padding:44px 22px;min-height:100vh}
.wrap{max-width:920px;margin:0 auto}.eyebrow{font-family:var(--mono);font-size:.62rem;letter-spacing:2px;text-transform:uppercase;color:#5a5a70;margin-bottom:8px}
h1{font-size:1.7rem;margin-bottom:6px}.sub{color:var(--dim);margin-bottom:30px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:15px}
.card{display:block;background:linear-gradient(165deg,#1b1b27,#15151f);border:1px solid var(--border);border-radius:14px;padding:20px;color:inherit;position:relative;transition:.18s}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card .v{position:absolute;top:16px;right:16px;font-family:var(--mono);font-size:.6rem;color:var(--accent);border:1px solid rgba(0,224,208,.2);padding:2px 7px;border-radius:5px}
.card h2{font-size:1.05rem;margin-bottom:5px;padding-right:42px}.card .client{font-family:var(--mono);font-size:.64rem;color:var(--dim);margin-bottom:16px}
.card .meta{font-size:.74rem;color:var(--dim);margin-bottom:16px}
.card .meta .thm{display:inline-flex;align-items:center;gap:5px}.card .meta .thm i{width:9px;height:9px;border-radius:50%;display:inline-block}
.card .links{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--border);padding-top:14px}
.card .go{font-size:.82rem;color:var(--accent);font-weight:600;text-decoration:none}
.card .edit{font-size:.74rem;color:var(--dim);text-decoration:none}.card .edit:hover{color:var(--accent)}
.toplink{display:inline-block;margin-bottom:24px;font-size:.78rem;color:var(--accent);text-decoration:none;border:1px solid var(--border);padding:7px 13px;border-radius:8px}
.toplink:hover{border-color:var(--accent)}
</style></head><body><div class="wrap"><div class="eyebrow">Escape Engine</div>
<h1>Catalogue des jeux</h1><div class="sub">${games.length} jeu(x) déployé(s).</div>
<a class="toplink" href="./theme-editor.html">🎨 Gérer les thèmes</a>
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
// Une seule page admin à la racine (modèle vierge ; charge un jeu via ?config=slug/config.json)
let adminHtml = injectAdminConfig(ADMIN, blankTemplate());
adminHtml = adminHtml.replace('let THEME_LIB = [];', 'let THEME_LIB = ' + JSON.stringify(Object.values(THEMES)) + ';');
writeFileSync(join(OUT, 'admin.html'), adminHtml);
// Bibliothèque de thèmes : on la copie pour que l'admin et l'éditeur puissent la lire
if (existsSync(join(ROOT, 'themes.json'))) copyFileSync(join(ROOT, 'themes.json'), join(OUT, 'themes.json'));
// Éditeur de thème (gère la bibliothèque themes.json)
if (THEME_EDITOR) writeFileSync(join(OUT, 'theme-editor.html'), THEME_EDITOR);
// .nojekyll pour que GitHub Pages serve tout tel quel
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`\n✅ ${built.length} jeu(x) · ${Object.keys(THEMES).length} thème(s) → docs/`);
