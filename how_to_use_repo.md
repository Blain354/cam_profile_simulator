# 🚀 Fullstack Hybrid Template: React 19 (Compiler) + Python FastAPI

This repository is a production-ready boilerplate for modern fullstack applications. It bridges the performance of **React 19** with the flexibility of **Python**, all orchestrated by **Docker** and **Traefik**.

---

## 🏗️ System Architecture

* **Frontend:** React 19 + TypeScript + **React Compiler**. Served by a high-performance **Nginx** server.
* **Backend:** Python 3.9 + **FastAPI**. Served by **Uvicorn** in the container (see `backend/Dockerfile`).
* **Reverse Proxy:** **Traefik v3**. Handles automatic Let's Encrypt SSL certificates and routing.
* **Networking:** Private virtual bridge (`web_network`). Services communicate internally via Docker DNS.

---

## 🚀 Deployment Instructions

1.  **Fork** this repository to your GitHub account.
2.  **Trigger via Discord (OpenClaw):**
    Send this command to your agent:
    > "Deploy project **[NAME]** using repo **git@github.com:[USER]/[REPO_NAME].git**"
3.  **Access your App:**
    * **Frontend:** `https://[NAME].blain-projects.ca`
    * **Backend API:** `https://api.[NAME].blain-projects.ca`

### Docker Compose prerequisites (database + networking)

1. **Network:** external `web_network` (Traefik). If missing: `docker network create web_network`.
2. **Labels:** `PROJECT_NAME`, `DOMAIN_NAME` (`.env` or secrets).
3. **SQLite:** file `/app/data/simulator.db`; volume `backend_data` → `/app/data`. Path override: **`SIM_DB_PATH`**. Schema at startup; optional one-time JSON import from `configs/` in image. No DB service container.

### Database — agent debug map (SQLite)

Misconceptions vs facts:

| Wrong assumption | Actual |
|------------------|--------|
| TCP host/port “to the database” | **SQLite = file on disk.** No DB socket. “Connection refused” → usually **HTTP** (backend/Traefik/URL), not SQLite. |
| Postgres required for compose | **No Postgres in default compose.** Don’t debug PG creds unless you added a `db` service. |
| Data lost on redeploy | **Volume** not on `/app/data`, or **`SIM_DB_PATH`** outside volume → new empty DB. |

**Checks (order):**

1. Backend up? (e.g. `/api/health`.)
2. In container: **`SIM_DB_PATH`** or `/app/data/simulator.db` — parent exists, writable (`storage.py` creates dirs).
3. Compose: **`backend_data:/app/data`** still bound (named volume, not dropped).
4. Code: `default_db_path()` in `backend/storage.py` ← **`SIM_DB_PATH`**.

**Symptom → cause:**

- **500 on config routes** → SQLite I/O (path, perms, disk), not network DB.
- **Empty configs after deploy** → persistence path/volume wrong.
- **Browser fetch fails** → API/CORS/Traefik; **not** SQLite protocol.

---

## 📡 Communication Protocol

Crucial distinction for developers:

1.  **Browser to API (External):** Your React code (running in the user's browser) **must** use the public URL:
    `fetch('https://api.[NAME].blain-projects.ca/api/status')`
2.  **Server to Server (Internal):** If you add a service (like a database manager or a worker) that needs to talk to the Python backend, use the Docker alias:
    `http://backend:5000/api/status` (Faster, bypasses the public internet).

---

## ⚠️ Critical Development Notes

* **React Compiler:** This template uses the new React 19 Compiler. You no longer need `useMemo` or `useCallback` in most cases; the compiler optimizes re-renders automatically.
* **CORS Management:** The FastAPI backend enables CORS for cross-subdomain communication (browser → API on another host).
* **Statelessness:** Docker containers are **ephemeral**. Any file saved inside a container will be deleted on the next deploy. Use **Volumes** for persistent data.

---

## 🤖 IoT, Robotics & Embedded Integration

Since this stack is designed for engineering projects, here are the recommendations for hardware integration:

### 1. Protocol: REST vs. WebSockets vs. MQTT
* **REST (Standard):** Best for periodic sensor updates. Send POST requests from your ESP32/Raspberry Pi to the API endpoint.
* **WebSockets (Real-time):** If you are building a **robotic controller** (like a gauntlet or exoskeleton), use WebSockets to reduce latency between the UI and the hardware.
* **MQTT (Scalable IoT):** For a fleet of sensors, add a **Mosquitto** container to the `docker-compose.yml`. MQTT is more resilient to unstable network conditions.

### 2. Embedded Security
* **TLS/SSL:** Traefik provides modern HTTPS. Ensure your microcontrollers support **TLS 1.2/1.3**.
* **Authentication:** Use a unique `X-API-KEY` header for your devices. Never hardcode GitHub or SSH keys on the hardware itself.

---

## 📈 Scaling & Advanced Tips

### Optional: migrate to PostgreSQL (not required for this repo)

The cam profile simulator ships with **SQLite on a Docker volume** (`backend_data` → `/app/data`). If you later replace SQLite with PostgreSQL, add a service and point the backend code at that database; example skeleton:

```yaml
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - web_network
```

You would also add `postgres_data` under the top-level `volumes:` key and update the application to use PostgreSQL instead of SQLite.

### Resource Management
If your backend performs heavy robotic simulations or AI processing:
-   **Limits:** Add `deploy.resources.limits` in Docker to prevent a single project from consuming all the server's RAM.
-   **Background Tasks:** Use **Celery** with **Redis** if a Python function takes more than 5 seconds to execute.

---
### Sources & Documentation
* **React Compiler (React Forget):** [Official React Documentation](https://react.dev/learn/react-compiler)
* **Docker Compose Networking:** [Docker Docs](https://docs.docker.com/compose/networking/)
* **Traefik Docker Provider:** [Traefik v3 Documentation](https://doc.traefik.io/traefik/routing/providers/docker/)