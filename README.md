# Simulation came profile

Projet de simulation d'un profil de came pour valve pneumatique, avec:

- un backend FastAPI qui calcule la geometrie de came, les jeux mecaniques et le debit d'air;
- un frontend React/Vite qui permet d'ajuster les parametres et visualiser les courbes;
- un systeme de sauvegarde/chargement de configurations JSON dans le dossier `configs/`.

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
- `configs/`: profils de configuration sauvegardes.

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
- `GET /api/health`: verification rapide du backend.

## Notes

- Le frontend utilise `VITE_API_BASE_URL` (fichier `frontend/.env.local`).
- Valeur recommandee: `http://localhost:8001`.
- Les configurations sont stockees en JSON dans `configs/`.
