# Simulation came profile

Projet de simulation d'un profil de came pour valve pneumatique, avec:

- un backend FastAPI qui calcule la geometrie de came, les jeux mecaniques et le debit d'air;
- un frontend React/Vite qui permet d'ajuster les parametres et visualiser les courbes;
- un systeme de sauvegarde/chargement de configurations via une base SQLite (avec migration automatique depuis `configs/` legacy).

## A quoi ca sert

Ce projet sert a:

- evaluer l'impact des parametres mecaniques (deadband, epaisseur, K, vitesse moteur, etc.);
- estimer l'ouverture du tube en fonction de la position/du temps;
- approximer le debit pneumatique resultant;
- comparer et conserver des profils de simulation.

## Architecture rapide

- `backend/main.py`: API FastAPI (`/api/simulate`, gestion des configs, healthcheck).
- `backend/simulation.py`: logique numerique de simulation.
- `backend/linkage.py`: mecanismes a barres (onglets Bar Linkage, Lever Linkage et Pendulum Linkage, miroir double gauche-droite et haut-bas) : cinematique du point de pincement, debit statique, traces d'air entrant / sortant d'une chambre sur le cycle 0, +stroke, 0, -stroke, 0 a la vitesse lineaire chargee (vitesse moteur a vide x facteur de charge x pas de vis), bouton Oscillate qui rejoue ce cycle en temps reel et marque ce temps sur les traces, recherche des longueurs de barres et de la distance d'ancrage par tirage aleatoire sur les plages, puis tirages resserres autour des meilleurs. Most flow, least dead band (defaut) cherche d'abord le plus grand debit atteignable, puis la bande morte la plus etroite, puis le trajet le plus court, sans ecraser le tube ferme au-dela de la limite ni travailler a moins de 0,2 mm du point mort des barres. Pour le pendule, le pied et son angle sont cherches aussi. Le sur-pincement du tube ferme n'est contraint que sur le trajet utilise. Si le plein debit est atteint, la course retournee est ce trajet, arrondi vers le haut ; sinon c'est le trajet encore permis par la portee du mecanisme et par la limite de sur-pincement, arrondi vers le bas. Elle ne depasse pas le trajet maximum de la recherche. Follow target vise la courbe cible sur toute la course. Le resultat indique le trajet jusqu'au premier debit, la bande morte et le temps jusqu'au plein debit a la vitesse lineaire chargee. Des profils sont enregistres par type de mecanisme (`/api/linkage/profiles`). Forces a la pression reglee : moindre force pour sceller (pion juste ferme, sans precharge), et force du pion a Y = 0, precharge comprise (pliage du tube, ecrasement des parois d'apres la compliance, air). Poussee de vis requise contre poussee disponible du moteur (couple, frottement du filet), recul du pion par flexion des barres et pression que le scellement tient encore. Des qu'un pion atteint la paroi a travers le tube ferme, la force, la flexion et la poussee ne sont plus donnees a partir de ce trajet, dans les deux sens (`/api/linkage/simulate`, `/api/linkage/optimize`). Ecrasement du tube : a chaque position, le tube ecrase repousse le pion jusqu'a l'equilibre avec la flexion des barres ; le debit, la bande morte et le temps de reponse utilisent l'ecart qui en resulte (interrupteur Tube pushes the pin back ; l'optimiseur cherche encore sur barres rigides). Le schema dessine le tube deforme sous le pion et les barres a leur largeur reelle. Pendule : le lien r peut etre un arc de cercle tangent au pied au joint, a Y = 0 (Curved link) ; les pivots ne bougent pas, la flexion de l'arc sous la traction entre dans la raideur au pion et dans les contraintes. Pendule en une piece (One piece, built into the shell) : bras, pied et lien forment une seule piece encastree dans la coque a l'ancrage, sans pivot ; le chariot la fait flechir. Le schema dessine les lignes moyennes flechies de cette piece, sans les pivots. Modele de poutres en petites deformations (`_Flexure`, `_frame_solve`) : la piece est fabriquee dans sa forme a Y = 0, et chaque pose est la somme de deux formes, celle que donne 1 mm de course sans tube et celle que donne 1 N sur le pion. Il en sort le gain du pion, la raideur au pion, la poussee de vis pour flechir les deux pieces, la contrainte le long de la piece contre la resistance du materiau (Material strength, 40 MPa suppose), le troncon ou elle est la pire (bras, pied ou lien) et si ce pic est a la coque, au joint, au chariot ou ailleurs sur ce troncon, le trajet ou elle est depassee et la plus grande rotation (au-dela d'environ 10 degres le modele derive). Cote chariot, le lien tourne sur une tige d'acier (1,5 x 8 mm par defaut), seul vrai pivot de la piece ; l'interrupteur Carriage end clamped l'encastre a la place. Avec la tige, la charge sur la tige, la pression dans l'oeil du lien et la flexion de la tige sont donnees. La tige est moitie dans le chariot, moitie dans l'oeil du lien : pression = charge / (diametre x demi-longueur), flexion a la face du chariot avec la charge au milieu de l'oeil. Les conges et les concentrations de contrainte aux jonctions ne sont pas modelises. Au-dela du trajet ou le pion de cette piece atteint la paroi, la contrainte n'est plus donnee, comme la force. Quand le tube repousse le pion, ce trajet est celui de l'ecart qui reste une fois la piece flechie : une piece trop souple n'ecrase pas le tube ferme jusqu'a la paroi, et il n'y a pas de blocage. L'optimiseur cherche encore sur la version a pivots. Materiau des barres : une liste deroulante regle d'un coup le module et la resistance (PETG 2 500 / 40 MPa et PLA 3 500 / 50 MPa fournis, valeurs indicatives pour des pieces imprimees) ; des valeurs reglees a la main s'enregistrent sous un nom comme materiau personnalise, garde cote serveur et commun aux trois mecanismes (`/api/linkage/materials`). Bouton Write to Onshape variables : compare les dimensions a l'ecran aux variables Onshape de meme nom, puis ecrase celles qui sont cochees (`/api/linkage/onshape/preview`, `/api/linkage/onshape/apply`, voir `docs/onshape-export.md`).
- `frontend/`: interface utilisateur React + Recharts.
- `simulation_came.py`: script standalone (visualisation matplotlib) pour test local rapide.
- `backend/data/simulator.db`: base de donnees de persistance (configs + extension future solver/profile builder).

## Prerequis

- Python 3.10+
- Node.js 20+ (npm inclus)

## Quick start

### 1) Lancer le backend (Terminal 1)

Depuis la racine du projet:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install fastapi "uvicorn[standard]" numpy matplotlib
uvicorn backend.main:app --reload --reload-dir backend --host 0.0.0.0 --port 8001
```

Backend disponible sur: `http://localhost:8001`

Test rapide:

```powershell
curl http://localhost:8001/api/health
```

### 2) Lancer le frontend (Terminal 2)

Creer/mettre a jour `frontend/.env.local` pour pointer le frontend vers le backend:

```powershell
Set-Content -Path .\frontend\.env.local -Value "VITE_API_BASE_URL=http://localhost:8001"
```

Le frontend depend du package prive `@blain-projects/ui` (registry GitHub
Packages). Avant `npm install`, exporter un token avec droit `read:packages` :

```powershell
$env:NODE_AUTH_TOKEN = "<github-pat-read-packages>"
```

`frontend/.npmrc` pointe `@blain-projects` vers `npm.pkg.github.com` et lit
`${NODE_AUTH_TOKEN}`. Meme variable pour un build Docker Compose, passee comme
secret BuildKit `npm_token` (`secrets:` → `frontend/Dockerfile`), jamais en
build-arg.

```powershell
cd frontend
npm install
npm run dev
```

Frontend disponible sur: `http://localhost:5173`

Chrome UI partage (header full-width, theme, champs kit, `SiteFooter`
sous l'outil plein ecran, labels en sentence case, kit
`@blain-projects/ui` ^3.3.1, surfaces plates et motion 250 ms,
attentes Solve / export STL via `Button.loading` / `LoadingState` / `Loader`) : voir
[`docs/ui-uniformity-2026-10-08.md`](docs/ui-uniformity-2026-10-08.md).
En Docker, passer `APP_VERSION` / `APP_COMMIT` / `APP_COMMIT_DATE` au build
frontend pour peupler le pied de page (pas de `.git` dans l'image) — voir
le commentaire dans `docker-compose.yml`.

## Demarrer toute la stack ensuite

Apres la premiere installation:

Terminal 1 (backend):

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn backend.main:app --reload --reload-dir backend --host 0.0.0.0 --port 8001
```

Terminal 2 (frontend):

```powershell
cd frontend
npm run dev
```

## Option: lancer la simulation standalone

Si vous voulez tester uniquement le modele Python avec generation de figure:

```powershell
.\.venv\Scripts\Activate.ps1
python simulation_came.py
```

Image generee: `simulation_came_profile.png`

## Endpoints utiles

- `POST /api/simulate`: lance une simulation avec les parametres fournis.
- `GET /api/configs`: liste les configs sauvegardees.
- `POST /api/save-config`: sauvegarde la config courante.
- `GET /api/builder-experiences`: liste les experiences Profile Builder sauvegardees.
- `POST /api/builder-experiences`: enregistre une experience solver (combinaisons candidates + note + contexte).
- `GET /api/export/stl-config`: etat de la pipeline d'export STL Onshape (cles + identifiants de document).
- `POST /api/export/stl-stream`: NDJSON stream — pousse la config vers Onshape, lance la traduction STL, retourne `download_url`.
- `GET /api/export/stl-download/{job_id}`: one-shot — telecharge le binaire STL produit (cache 10 min).
- `GET /api/health`: verification rapide du backend.

## Export STL via Onshape

Bouton **Export STL** dans le header → `StlExportModal` qui suit en direct
chaque etape (auth, push des variables, traduction) avec une progress bar et
un log granulaire. Quand le backend a fini, le STL reste en cache (~10 min) :
il faut cliquer **Download STL** pour declencher `window.showSaveFilePicker`
(geste utilisateur requis ; fallback `<a download>` si l'API absente).

Le backend reutilise le skill OpenClaw `onshape`
(`~/.openclaw/workspace/skills/onshape/`) : meme schema HMAC, meme workflow
de translation, mais embarque directement dans `backend/onshape_export.py`
pour rester portable en Docker.

Configuration requise (voir [`docs/onshape-export.md`](docs/onshape-export.md)) :

```env
ONSHAPE_ACCESS_KEY=...
ONSHAPE_SECRET_KEY=...
ONSHAPE_DOCUMENT_ID=...
ONSHAPE_WORKSPACE_ID=...
ONSHAPE_ELEMENT_ID=...
```

## Rampe de fermeture optionnelle

Le toggle **Closure ramp**, dans l'Explorer et le Profile Builder, remplace le
plateau cote fermeture par une rampe sur ses 10 mm existants. `ramp_enabled`
est sauvegarde avec les configurations et les experiences; les anciennes
configurations conservent le plateau par defaut.

Avec `Y_join = -deadband/2` et `Y_closed = Y_join - 10`, le decalage de came
vaut 0 mm a `Y_closed` et `default_distance` a `Y_join`. La rampe utilise
`default_distance × (3u² - 2u³)`, ou `u = (Y - Y_closed)/10`, pour rejoindre
tangentiellement la courbe d'ouverture inchangee. Les axes actuels sont
conserves : Y croissant ouvre le tube. Les graphiques montrent toute la rampe.

Le gap physique reste la distance minimale bushing/came plus le jeu radial
de 0,25 mm. La rampe tient compte du contact avec les segments du profil,
et non seulement de l'ecart horizontal a la meme coordonnee Y. Le debit est nul
si `gap <= OD - ID - compliance × pression_MPa`. Le seuil depend donc du tube
et de la pression; atteindre un decalage geometrique nul ne force pas
artificiellement un debit nul. La compliance reste une approximation elastique
statique : aucune force radiale, relaxation viscoelastique ou hysteresis n'est
calculee.

Le sketch Onshape actuel supporte uniquement le plateau. L'export STL en mode
rampe est bloque explicitement jusqu'a ce que le sketch CAD reproduise ce mode.

Validation numerique : `python -m unittest discover -s backend/tests -v`.

## Alignement avec le template `web_projects/`

Ce projet suit la meme structure que `web_projects/web_projects_template/` :
`backend/` (FastAPI), `frontend/` (Vite + React 19), `docker-compose.yml`
branche sur `web_network`, `.env` pour les secrets, `docs/` pour la
documentation longue. Pour la communication avec les agents OpenClaw
(Makey, Codey, etc.), voir [`web_projects_template/OPENCLAW.md`](../web_projects_template/OPENCLAW.md).

## Notes

- Le frontend utilise `VITE_API_BASE_URL` (fichier `frontend/.env.local`).
- Valeur recommandee: `http://localhost:8001`.
- Les configurations sont stockees en base SQLite (`SIM_DB_PATH` optionnel pour surcharger le chemin).
