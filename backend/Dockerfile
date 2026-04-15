FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 5000
# SQLite DB path: /app/data/simulator.db (see docker-compose volume backend_data)
ENV SIM_DB_PATH=/app/data/simulator.db
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]