FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
COPY app ./app

# run deps
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir ".[dev]" || \
    pip install --no-cache-dir fastapi uvicorn psycopg[binary] pydantic pydantic-settings \
        python-jose[cryptography] passlib[bcrypt] qrcode[pil] Pillow python-multipart

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]