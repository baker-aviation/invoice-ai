FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2-dev libxslt1-dev gcc && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY supa.py .
COPY auth_middleware.py .
COPY swim_client.py .
COPY main.py .

RUN useradd -r -s /bin/false appuser
USER appuser

ENV PORT=8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
