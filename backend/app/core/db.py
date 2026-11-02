"""Conexion a SQLite usando aiosqlite.

Usamos una conexion efimera por request via dependency `get_db()`.
Las funciones criticas del esquema usan sus propias transacciones.
"""

import asyncio
import os
import sqlite3
from collections.abc import Generator
from contextlib import asynccontextmanager

from app.core.config import get_settings

# Modo serverless (Vercel): cada invocacion es un proceso independiente.
_SERVERLESS = os.environ.get("VERCEL") == "1"

# Ruta absoluta para que persista entre requests en Vercel/serverless.
DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "dev.db",
)

# Asegurar que la BD existe al importar este modulo.
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

if not os.path.exists(DB_PATH):
    conn0 = sqlite3.connect(DB_PATH)
    conn0.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password_hash TEXT, name TEXT, role TEXT, active BOOLEAN DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)")
    conn0.execute("CREATE TABLE IF NOT EXISTS venues (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, capacity INTEGER, address TEXT)")
    conn0.execute("CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, venue_id INTEGER, user_id INTEGER, status TEXT, token_hash TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (venue_id) REFERENCES venues(id), FOREIGN KEY (user_id) REFERENCES users(id))")
    conn0.execute("CREATE TABLE IF NOT EXISTS ticket_status (id INTEGER PRIMARY KEY, name TEXT)")
    conn0.execute("INSERT OR IGNORE INTO ticket_status (id, name) VALUES (1, 'issued'), (2, 'voided'), (3, 'refunded'), (4, 'redeemed')")
    conn0.commit()
    conn0.close()

_conn: sqlite3.Connection | None = None


def get_connection() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH)
        _conn.row_factory = sqlite3.Row
    return _conn


def close_connection() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


async def get_db() -> Generator[sqlite3.Connection, None, None]:
    global _conn
    if _SERVERLESS:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()
        return
    conn = get_connection()
    try:
        yield conn
    finally:
        pass  # Mantener la conexion abierta para el pool local