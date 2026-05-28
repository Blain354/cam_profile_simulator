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

```powershell
cd frontend
npm install
npm run dev
```

Frontend disponible sur: `http://localhost:5173`

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
chaque etape (auth, push des variables, traduction, telechargement) avec une
progress bar et un log granulaire. A la fin, on ouvre une boite de dialogue
"Enregistrer sous" via `window.showSaveFilePicker` (fallback `<a download>`
sur Firefox).

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
