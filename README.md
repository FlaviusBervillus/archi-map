# ArchiMap

Application web interactive pour **cartographier l'architecture d'un projet** : arborescence des fichiers,
liens entre fichiers (qui importe quoi), et **doublons dans les fichiers de traduction** (« Annuler », « Email »…)
afin de tout regrouper et d'optimiser l'organisation des dossiers, des fichiers et du code.

> 🔒 Tout est analysé **localement dans le navigateur** : aucun fichier n'est envoyé sur internet.

## Utilisation

1. Ouvrez l'application (GitHub Pages, ou en local — voir plus bas).
2. Cliquez sur **Ouvrir un dossier** (ou glissez-déposez le dossier de votre projet dans la page).
   Pas de projet sous la main ? Cliquez sur **Essayer avec un projet de démo**.
3. Naviguez entre les onglets :

| Onglet | Ce que vous y trouvez |
| --- | --- |
| **Vue d'ensemble** | Chiffres clés, structure, types de fichiers, pistes d'optimisation prioritaires |
| **Arborescence** | L'arbre des dossiers. Chaque fichier affiche `→ n` (fichiers importés), `← n` (fichiers qui l'utilisent), `🌐 n` (clés de traduction utilisées). Un clic ouvre le détail : imports, utilisateurs, paquets externes, clés de traduction utilisées, textes en dur… |
| **Graphe des liens** | Graphe interactif des dépendances, par fichier ou par dossier (profondeur réglable). Zoom, déplacement, clic pour surligner les voisins. Les cycles sont en rouge. |
| **Traductions** | Doublons de textes (par langue), clés inutilisées, clés manquantes, textes écrits en dur qui existent déjà en traduction, tableau de toutes les clés. |
| **Optimisations** | Dépendances circulaires, fichiers orphelins, fichiers identiques, noms en double (`utils.ts` ×4…), dossiers interdépendants, gros fichiers… |

### Regrouper les traductions en double

Dans **Traductions → Doublons**, chaque carte regroupe des clés différentes qui ont le même texte :

- **fusion sûre** : les autres langues ont aussi le même texte pour ces clés → on peut fusionner sans risque ;
- **à vérifier** : une autre langue traduit différemment (ex. `modal.cancel` = « Dismiss » en anglais) → le contexte n'est peut-être pas le même.

Options : ignorer la casse, les accents, la ponctuation finale (« Email : » = « Email »), **mode souple** (« E-mail » = « Email »).

Cochez les groupes, ajustez la clé commune proposée (ex. `common.cancel`), puis exportez :

- **Plan de migration (JSON)** — à appliquer automatiquement avec l'outil ci-dessous ;
- **Rapport (Markdown)** et **CSV** — pour partager / planifier.

### Appliquer le plan à votre projet

```bash
# Simulation : affiche ce qui serait modifié
node tools/apply-plan.mjs ../mon-projet archimap-plan-mon-projet.json

# Application réelle (committez avant !)
node tools/apply-plan.mjs ../mon-projet archimap-plan-mon-projet.json --write
```

Le script supprime les clés en double des fichiers JSON/ARB, ajoute la clé commune dans chaque langue,
et remplace `'login.cancel'` par `'common.cancel'` dans le code. Les clés construites dynamiquement
(`` t(`errors.${code}`) ``) ne peuvent pas être détectées : vérifiez-les à la main.

## Ce qui est reconnu

- **Code** : JS/TS (React, Vue, Svelte, Angular, Astro), CSS/SCSS/Less, HTML, Dart/Flutter, Python, PHP.
  Alias `tsconfig.json`/`jsconfig.json` (`paths`, `baseUrl`), alias Vite/Webpack simples, `@/` et `~/` → `src/`, `package:` Dart.
- **Traductions** :
  - JSON (i18next, vue-i18n, ngx-translate, react-intl…) dans un dossier `i18n`, `locales`, `lang`, `translations`, `l10n`… ou nommés `fr.json`, `en-US.json`, `fr/common.json`, `messages.fr.json` ;
  - YAML (Rails, Symfony), Flutter `.arb`, Android `values-xx/strings.xml`, iOS `xx.lproj/*.strings`, Java `*_fr.properties`.
- Dossiers ignorés par défaut : `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`… (modifiables via ⚙).

## Lancer en local

L'application est 100 % statique (HTML + JS, sans build). Les modules ES nécessitent un petit serveur :

```bash
npm start          # http://localhost:8080
# ou : python3 -m http.server 8080
```

Ajoutez `?demo` à l'URL pour charger directement le projet de démo.
« Ouvrir un dossier » utilise l'API File System Access (Chrome, Edge) avec un bouton **Rescanner** ;
les autres navigateurs utilisent le sélecteur de dossier classique ou le glisser-déposer.

## Mettre en ligne avec GitHub Pages

Le workflow `.github/workflows/pages.yml` lance les tests puis publie le site à chaque push sur `main`.
À faire une fois : **Settings → Pages → Build and deployment → Source : GitHub Actions**.

## Tests

```bash
npm test
```

## Structure

```
index.html          page unique
css/style.css       styles (thème clair / sombre)
js/app.js           interface
js/project.js       orchestration de l'analyse, arbre, recommandations
js/deps.js          extraction et résolution des imports, cycles
js/i18n.js          traductions : détection, parsing, doublons, usages
js/graph.js         graphe D3
js/loader.js        lecture du dossier dans le navigateur
js/demo.js          projet de démonstration
tools/apply-plan.mjs  application du plan de migration des traductions
test/               tests (node --test)
```
