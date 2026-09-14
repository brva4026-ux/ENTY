FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app

# run deps (sin -e: en la imagen no hace falta instalacion editable)
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir "." || \
    pip install --no-cache-dir fastapi uvicorn psycopg[binary] pydantic pydantic-settings \
        python-jose[cryptography] passlib[bcrypt] qrcode[pil] Pillow python-multipart

EXPOSE 8000

# Render inyecta $PORT; uvicorn con loop por defecto (uvloop en Linux) es
# compatible con psycopg async. El fix de ProactorEventLoop solo aplica a Windows.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]