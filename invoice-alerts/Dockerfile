# Dockerfile
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps (optional but commonly useful)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run listens on $PORT
ENV PORT=8080
EXPOSE 8080

# If your FastAPI app instance is `app` inside `main.py`
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]