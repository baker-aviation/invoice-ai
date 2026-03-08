FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY supa.py .
COPY auth_middleware.py .
COPY main.py .
# cache-bust: 2026-02-26-fix-source-invoice-id

RUN useradd -r -s /bin/false appuser
USER appuser

ENV PORT=8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]