"""Launcher local (Windows).

Dos cosas que el CLI de uvicorn no permite hacer bien en Windows:
1. psycopg async exige SelectorEventLoop (uvicorn con loop="auto" fuerza
   Proactor en Windows y lo revierte). Con loop="none" respetamos la policy.
2. Puerto configurable via API_PORT (el 8000 puede estar ocupado en este
   entorno; default 8001).

Uso: python run.py
"""
import asyncio
import os
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn

if __name__ == "__main__":
    config = uvicorn.Config(
        "app.main:app",
        host=os.getenv("API_HOST", "127.0.0.1"),
        port=int(os.getenv("API_PORT", "8001")),
        log_level="info",
        loop="none",  # no dejar que uvicorn re-fuerce ProactorEventLoop
    )
    server = uvicorn.Server(config)
    asyncio.run(server.serve())
