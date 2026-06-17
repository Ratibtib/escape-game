# Escape Engine — déploiement multi-jeux (apps installables)

Un seul moteur, plusieurs jeux, chacun **installable comme sa propre app** (nom + icône
propres sur l'écran d'accueil). Tout vit dans **un seul dépôt, une seule branche**.

## Pourquoi cette structure

Pour qu'un client puisse *installer* son escape game (PWA), il faut **un `manifest.json` par
jeu**. Le `?config=` ne suffit pas : une app installée ignore le paramètre d'URL et se relancerait
sur le jeu par défaut. La solution : **un dossier par jeu**, chacun avec son manifest. Pour ne pas
maintenir 10 copies du moteur à la main, `build.mjs` le recopie automatiquement.

## Arborescence

```
escape-engine/
├── engine/
│   ├── index.html         ← LE MOTEUR (la seule chose à maintenir)
│   └── sw.template.js      ← gabarit du service worker
├── assets/                 ← médias master (audio, icônes) — une seule copie
│   ├── Fouras.m4a, intro3.m4a, melody.wav
│   └── icons/…
├── games/
│   ├── projet-1986/config.json   ← un fichier par jeu (exporté depuis admin.html)
│   └── mariage-demo/config.json
├── build.mjs               ← génère le dossier docs/ déployable
└── docs/                   ← SORTIE générée (à publier) — ne pas éditer à la main
    ├── index.html          ← catalogue listant les jeux
    ├── projet-1986/        ← app installable complète
    └── mariage-demo/
```

## Ajouter un nouveau jeu (le flux complet)

1. Dans **`admin.html`**, personnalise le contenu, puis **Exporter config.json**.
2. Crée un dossier `games/<slug>/` (ex : `games/noel/`) et déposes-y le fichier sous le nom
   `config.json`.
3. Si le jeu utilise de **nouvelles images/sons**, dépose-les dans `assets/` (mêmes chemins que
   ceux indiqués dans le config, ex : `assets/icons/sapin.png`).
4. Lance le build :
   ```
   node build.mjs
   ```
5. Commit + push. C'est en ligne.

Tu ne dupliques **jamais** le moteur ni le manifest à la main : le script s'en charge, et ne copie
dans chaque dossier que les médias réellement utilisés par ce jeu.

## Mettre à jour le moteur (corriger un bug partout)

Édite **`engine/index.html`** une seule fois, relance `node build.mjs`. La correction est
répercutée dans tous les jeux. Pense à incrémenter `meta.version` du/des jeux concernés (dans
l'admin) pour forcer le rafraîchissement du cache des apps déjà installées.

## Publier sur GitHub Pages

Settings → Pages → Source : **branche `main`, dossier `/docs`**. Les URL deviennent :

```
https://<utilisateur>.github.io/<repo>/              ← catalogue
https://<utilisateur>.github.io/<repo>/projet-1986/  ← un jeu (installable)
https://<utilisateur>.github.io/<repo>/mariage-demo/
```

Chaque sous-URL est une app à part entière : ouverte sur mobile, le navigateur propose
« Ajouter à l'écran d'accueil » avec le nom et l'icône définis dans le branding du jeu.

## Ce qui est généré pour chaque jeu

| Fichier | Origine |
|---|---|
| `index.html` | moteur tamponné — la copie de secours embarquée = la config du jeu |
| `config.json` | copié depuis `games/<slug>/` |
| `manifest.json` | **généré** depuis `branding` (nom, icône, couleurs) → installabilité |
| `sw.js` | **généré**, cache nommé `<slug>-v<version>`, scoppé au dossier |
| médias | uniquement ceux référencés par ce jeu |

## Personnaliser l'icône installée

Par défaut le manifest utilise `icons/icon-192.png` / `icon-512.png`. Pour une icône propre au
client, ajoute dans `branding` du config : `appIcon192`, `appIcon512` (chemins vers tes images),
et éventuellement `themeColor` / `backgroundColor`.

## Quand passer au back-office (base de données)

Cette structure de fichiers est **transitoire**. Le jour où tu branches une base (Supabase…),
les dossiers `games/` deviennent des lignes en base et `build.mjs` disparaît : une seule app sert
tous les jeux via `?game=ID`. L'éditeur (`admin.html`) et le moteur, eux, ne changent pas.
