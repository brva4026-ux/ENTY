"""Runner de uvicorn para Windows: fija SelectorEventLoop ANTES de crear el
loop (psycopg async no funciona con ProactorEventLoop). Uso:
    ./.venv/Scripts/python.exe run_uvicorn.py [puerto]
"""
import asyncio
import os
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn  # noqa: E402

from app.main import app  # noqa: E402  (se importa despues de fijar la politica)

port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8001"))

if __name__ == "__main__":
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        loop="none",  # no re-forzar ProactorEventLoop: respetar la policy de arriba
    )
    server = uvicorn.Server(config)
    asyncio.run(server.serve())
