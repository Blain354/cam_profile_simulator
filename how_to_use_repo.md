# 🚀 Fullstack Hybrid Template: React 19 (Compiler) + Python Flask

This repository is a production-ready boilerplate for modern fullstack applications. It bridges the performance of **React 19** with the flexibility of **Python**, all orchestrated by **Docker** and **Traefik**.

---

## 🏗️ System Architecture

* **Frontend:** React 19 + TypeScript + **React Compiler**. Served by a high-performance **Nginx** server.
* **Backend:** Python 3.9 + Flask. Managed by **Gunicorn** for production-grade concurrency.
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
* **CORS Management:** The Python backend uses `flask-cors`. This is mandatory for cross-subdomain communication.
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

### Adding a Persistent Database (PostgreSQL)
Update your `docker-compose.yml` with:
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

### Resource Management
If your backend performs heavy robotic simulations or AI processing:
-   **Limits:** Add `deploy.resources.limits` in Docker to prevent a single project from consuming all the server's RAM.
-   **Background Tasks:** Use **Celery** with **Redis** if a Python function takes more than 5 seconds to execute.

---
### Sources & Documentation
* **React Compiler (React Forget):** [Official React Documentation](https://react.dev/learn/react-compiler)
* **Docker Compose Networking:** [Docker Docs](https://docs.docker.com/compose/networking/)
* **Traefik Docker Provider:** [Traefik v3 Documentation](https://doc.traefik.io/traefik/routing/providers/docker/)