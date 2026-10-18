"""Fixture global de tests: aplica schema.sql + migraciones sobre la DB de prueba.

La DSN viene de TEST_DATABASE_URL (default: la DB local de desarrollo).
Si la DB no está disponible, los tests de negocio se saltan (no fallan)
para no romper flujos que no dependen de la DB.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[2]
SQL_FILES = [
    ROOT / "db" / "schema.sql",
    ROOT / "db" / "migrations" / "002_lifecycle.sql",
    ROOT / "db" / "migrations" / "003_ops_hardening.sql",
    ROOT / "db" / "migrations" / "004_edit_and_delete.sql",
    ROOT / "db" / "migrations" / "004_ticket_reissue.sql",
    ROOT / "db" / "migrations" / "005_event_edit_and_cancel.sql",
    ROOT / "db" / "migrations" / "006_redeem_event_guard.sql",
    ROOT / "db" / "migrations" / "007_push_subscriptions.sql",
    ROOT / "db" / "migrations" / "008_redeem_type_filter.sql",
    ROOT / "db" / "migrations" / "009_team_stats.sql",
    ROOT / "db" / "migrations" / "010_promoter_payouts.sql",
    ROOT / "db" / "migrations" / "011_staff_invitations.sql",
    ROOT / "db" / "migrations" / "012_in_app_notifications.sql",
    ROOT / "db" / "migrations" / "013_qr_activation.sql",
    ROOT / "db" / "migrations" / "014_push_outbox_and_location.sql",
    ROOT / "db" / "migrations" / "015_ticket_contact_audit.sql",
    ROOT / "db" / "migrations" / "016_login_lockout.sql",
    ROOT / "db" / "migrations" / "017_password_reset.sql",
    ROOT / "db" / "migrations" / "018_media.sql",
    ROOT / "db" / "migrations" / "019_security_p0.sql",
    ROOT / "db" / "migrations" / "020_auto_close_events.sql",
    ROOT / "db" / "migrations" / "021_ticket_return.sql",
    ROOT / "db" / "migrations" / "022_event_waitlist.sql",
    ROOT / "db" / "migrations" / "023_ticket_payments.sql",
    ROOT / "db" / "migrations" / "024_notify_autoclose_kind.sql",
    ROOT / "db" / "migrations" / "025_event_staff.sql",
    ROOT / "db" / "migrations" / "026_door_anomaly_alert.sql",
    ROOT / "db" / "migrations" / "027_door_anomaly_event_link.sql",
    ROOT / "db" / "migrations" / "028_legal_acceptances.sql",
    ROOT / "db" / "migrations" / "029_legal_documents_v11.sql",
    ROOT / "db" / "migrations" / "030_legal_plazos.sql",
]


def _dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )


@pytest.fixture(scope="session")
def db():
    """Conexión admin a la DB de prueba con el esquema limpio aplicado."""
    dsn = _dsn()
    try:
        conn = psycopg.connect(dsn, autocommit=True, row_factory=dict_row)
    except psycopg.OperationalError:
        pytest.skip("DB de prueba no disponible (configura TEST_DATABASE_URL)")

    # Esquema limpio en cada sesión de tests (orden inverso de dependencias)
    conn.execute(
        """
        DROP TABLE IF EXISTS notifications, push_outbox, staff_invitations, push_subscriptions, ticket_reissues,
            ticket_returns, event_waitlist, ticket_contact_edits, login_attempts, password_reset_tokens, media, audit_log,
            redemptions, promoter_payouts, tickets, promoter_allocations, ticket_types, events,
            venue_user_roles, venues, users, ticket_payments,
            -- Aceptaciones legales (mig 028): legal_acceptances referencia
            -- legal_documents, y ambas a users/venues. CASCADE resuelve el
            -- orden; se listan para que una corrida previa no deje las tablas
            -- y schema.sql choque con DuplicateTable.
            legal_acceptances, legal_documents CASCADE;
        -- event_staff / event_access_tokens (mig 025) referencian users y events:
        -- CASCADE los resuelve igual, pero se sueltan aparte y antes para que
        -- el orden de borrado no dependa de las FK.
        DROP TABLE IF EXISTS event_access_tokens, event_staff CASCADE;
        DROP TYPE IF EXISTS ticket_status, user_role CASCADE;
        -- redeem_ticket tuvo dos firmas (3 y 4 args, mig 008): un DROP sin
        -- firma lanza AmbiguousFunction si conviven overloads.
        DROP FUNCTION IF EXISTS redeem_ticket(bigint, text, bigint);
        DROP FUNCTION IF EXISTS redeem_ticket(bigint, text, bigint, bigint);            DROP FUNCTION IF EXISTS emit_ticket, void_ticket,
            reissue_ticket, set_event_status, notify_user, notify_venue_admins,
            notify_payout_lifecycle, notify_invitation_accepted,
            notify_ticket_reissued, correct_ticket_contact, events_check_capacity,
            return_ticket, offer_next_waitlist_spot, expire_waitlist_offers,
            join_waitlist, leave_waitlist, claim_waitlist, approve_ticket_payment,
            update_ticket_type, update_promoter_allocation,
            delete_ticket_type, delete_promoter_allocation,
            tickets_check_active_refs, update_event,
            events_check_transition,
            -- Lockout (016) y cierre automatico (020): desde que schema.sql
            -- es el esquema completo consolidado, estas funciones se crean
            -- con CREATE FUNCTION plano y hay que soltarlas explicitamente.
            login_locked, register_login_failure, clear_login_failures,
            prune_login_attempts, auto_close_expired_events
            CASCADE;
        """
    )
    # Red de seguridad: si queda CUALQUIER funcion huérfana en public (un
    # schema.sql a medias, una migración abortada), el esquema consolidado
    # chocaria con DuplicateObject y el lote entero se revertiria sin tablas.
    # Se sueltan todas y schema.sql las recrea completas.
    orphans = conn.execute(
        """
        SELECT 'DROP FUNCTION IF EXISTS ' || string_agg(
                   quote_ident(p.proname) || '('
                   || pg_get_function_identity_arguments(p.oid) || ')', ', ')
                   AS ddl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          -- Las funciones miembro de una extension (pgcrypto: digest) no se
          -- sueltan con DROP FUNCTION: moririan con DependentObjectsStillExist.
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
               WHERE d.objid = p.oid AND d.deptype = 'e'
          )
        """
    ).fetchone()
    if orphans and orphans["ddl"]:
        conn.execute(orphans["ddl"])
    for f in SQL_FILES:
        if not f.exists():
            raise RuntimeError(f"Falta el archivo SQL: {f}")
        conn.execute(f.read_text(encoding="utf-8"))

    yield conn
    conn.close()


@pytest.fixture()
def dbcur(db):
    """Cursor autocommit reutilizable."""
    with db.cursor() as cur:
        yield cur


# ===========================================================================
# Tests de la API (TestClient)
# ===========================================================================
TEST_PASSWORD = "test-password-123"


@pytest.fixture()
def api_client(db):
    """TestClient sobre la app real, con `get_db` apuntando a la DB de prueba.

    No se usa `with` a propósito: así NO se dispara el lifespan y no se crea el
    pool global de psycopg del proceso productivo (estado que no aporta nada
    en tests). Cada request abre una conexión efímera con los MISMOS kwargs que
    usa el backend en serverless (`_CONNECT_KWARGS`), de modo que el
    comportamiento —incluido el `commit()` sobre conexión autocommit— es
    idéntico al de producción.
    """
    os.environ["DATABASE_URL"] = _dsn()
    os.environ["JWT_SECRET"] = os.environ.get("JWT_SECRET", "test-secret")
    # El lockout de login (mig 016) cuenta fallos por IP en la DB. En tests,
    # TODOS los requests salen de la misma IP del TestClient: los 422/403 que
    # los tests de permisos provocan a propósito envenenan el cubo de IP y el
    # login de TODO test posterior responde 429. Cada test arranca con los
    # cubos limpios (los tests específicos del lockout siembran lo suyo).
    db.execute("DELETE FROM login_attempts")
    # El checkout publico rate-limitea por IP en memoria del proceso; el
    # TestClient siempre sale de la misma IP, asi que una rafaga de tests de
    # compra envenenaria el cubo y el siguiente responderia 429. Se limpia por
    # test (igual criterio que login_attempts).
    from app.routers import public as _public_mod
    _public_mod._checkout_bucket.clear()

    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.core.db import _CONNECT_KWARGS, get_db
    from app.main import create_app

    get_settings.cache_clear()
    app = create_app()

    async def _override_get_db():
        conn = await psycopg.AsyncConnection.connect(_dsn(), **_CONNECT_KWARGS)
        try:
            yield conn
        finally:
            await conn.close()

    app.dependency_overrides[get_db] = _override_get_db
    client = TestClient(app, base_url="http://testserver")
    # IP del TestClient conocida y constante: el lockout por IP queda
    # acotado a 'testclient' y cualquier test puede limpiarlo sin tocar
    # filas de otros cubos.
    client.headers.update({"x-real-ip": "testclient"})
    yield client
    get_settings.cache_clear()


@pytest.fixture()
def world(db) -> dict:
    """Escenario multi-tenant: venue A (admin/promotor/promotor2/bouncer) y una
    venue B con un admin ajeno, para probar el aislamiento entre venues."""
    from app.core.security import hash_password

    tag = uuid.uuid4().hex[:8]
    password_hash = hash_password(TEST_PASSWORD)

    def make_venue(label: str) -> int:
        return db.execute(
            "INSERT INTO venues (name, slug) VALUES (%s, %s) RETURNING id",
            (f"Venue {label} {tag}", f"venue-{label}-{tag}"),
        ).fetchone()["id"]

    def make_user(label: str, venue_id: int, role: str) -> dict:
        email = f"{label}-{tag}@example.test"
        user_id = db.execute(
            "INSERT INTO users (email, password_hash, full_name) "
            "VALUES (%s, %s, %s) RETURNING id",
            (email, password_hash, f"Usuario {label}"),
        ).fetchone()["id"]
        db.execute(
            "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, %s)",
            (venue_id, user_id, role),
        )
        return {"id": user_id, "email": email, "role": role}

    venue_a = make_venue("a")
    venue_b = make_venue("b")
    return {
        "password": TEST_PASSWORD,
        "venue_a": venue_a,
        "venue_b": venue_b,
        "admin": make_user("admin", venue_a, "admin"),
        "promoter": make_user("promotor", venue_a, "promotor"),
        "promoter2": make_user("promotor2", venue_a, "promotor"),
        "bouncer": make_user("bouncer", venue_a, "bouncer"),
        "outsider": make_user("ajeno", venue_b, "admin"),
    }


class Api:
    """Atajos HTTP con token por usuario, para tests de endpoints."""

    def __init__(self, client, world: dict):
        self.client = client
        self.world = world
        self._tokens: dict[str, str] = {}

    # --- auth ----------------------------------------------------------
    def token(self, who: str) -> str:
        if who not in self._tokens:
            res = self.client.post(
                "/auth/login",
                json={
                    "email": self.world[who]["email"],
                    "password": self.world["password"],
                },
            )
            assert res.status_code == 200, res.text
            self._tokens[who] = res.json()["access_token"]
        return self._tokens[who]

    def headers(self, who: str) -> dict:
        return {"Authorization": f"Bearer {self.token(who)}"}

    def get(self, path: str, who: str):
        return self.client.get(path, headers=self.headers(who))

    def post(self, path: str, who: str, json: dict | None = None):
        return self.client.post(path, headers=self.headers(who), json=json)

    def patch(self, path: str, who: str, json: dict | None = None):
        return self.client.patch(path, headers=self.headers(who), json=json)

    def delete(self, path: str, who: str):
        return self.client.delete(path, headers=self.headers(who))

    # --- atajos de escenario -------------------------------------------
    def create_event(
        self,
        who: str,
        venue_id: int,
        *,
        name: str = "Evento de prueba",
        capacity: int = 100,
        **extra,
    ) -> dict:
        # +29h: dentro de la ventana de activación del QR (default 60 min
        # antes, mig 013) pero con la apertura a futuro para poder publicar.
        # Los tests que necesitan la ventana CERRADA la crean explícita.
        payload = {
            "name": name,
            "starts_at": (datetime.now(timezone.utc) + timedelta(hours=29)).isoformat(),
            "capacity": capacity,
        }
        payload.update(extra)  # description, flyer_url, ends_at, event_timezone...
        res = self.post(f"/venues/{venue_id}/events", who, payload)
        assert res.status_code == 201, res.text
        return res.json()

    def publish(self, who: str, venue_id: int, event_id: int) -> dict:
        res = self.post(f"/venues/{venue_id}/events/{event_id}/publish", who)
        assert res.status_code == 200, res.text
        return res.json()

    @staticmethod
    def event_url(venue_id: int, event_id: int) -> str:
        return f"/venues/{venue_id}/events/{event_id}"

    def add_type(
        self,
        who: str,
        venue_id: int,
        event_id: int,
        *,
        name: str = "Cortesia",
        price_cents: int = 0,
        quantity: int = 10,
        is_courtesy: bool = True,
    ) -> dict:
        res = self.post(
            f"/venues/{venue_id}/events/{event_id}/types",
            who,
            {
                "name": name,
                "price_cents": price_cents,
                "quantity": quantity,
                "is_courtesy": is_courtesy,
            },
        )
        assert res.status_code == 201, res.text
        return res.json()

    def set_allocation(
        self,
        who: str,
        venue_id: int,
        event_id: int,
        *,
        ticket_type_id: int,
        promoter_id: int,
        capacity: int,
    ) -> dict:
        res = self.post(
            f"/venues/{venue_id}/events/{event_id}/allocations",
            who,
            {
                "ticket_type_id": ticket_type_id,
                "promoter_id": promoter_id,
                "capacity": capacity,
            },
        )
        assert res.status_code == 201, res.text
        return res.json()

    def emit(
        self,
        who: str,
        venue_id: int,
        event_id: int,
        *,
        ticket_type_id: int,
        allocation_id: int | None,
        customer_name: str = "Asistente",
    ) -> dict:
        res = self.post(
            f"/venues/{venue_id}/events/{event_id}/tickets",
            who,
            {
                "ticket_type_id": ticket_type_id,
                "allocation_id": allocation_id,
                "customer_name": customer_name,
                "customer_phone": "3001234567",
            },
        )
        assert res.status_code == 201, res.text
        return res.json()

    def allocations(self, who: str, venue_id: int, event_id: int) -> list:
        res = self.get(f"/venues/{venue_id}/events/{event_id}/allocations", who)
        assert res.status_code == 200, res.text
        return res.json()

    def types(self, who: str, venue_id: int, event_id: int) -> list:
        res = self.get(f"/venues/{venue_id}/events/{event_id}/types", who)
        assert res.status_code == 200, res.text
        return res.json()

    @staticmethod
    def type_url(venue_id: int, event_id: int, type_id: int) -> str:
        return f"/venues/{venue_id}/events/{event_id}/types/{type_id}"

    @staticmethod
    def allocation_url(venue_id: int, event_id: int, allocation_id: int) -> str:
        return f"/venues/{venue_id}/events/{event_id}/allocations/{allocation_id}"

    def scenario(self, *, capacity: int = 50, alloc_capacity: int = 5, type_quantity: int = 50) -> dict:
        """Evento publicado + tipo de cortesía + cupo del promotor."""
        venue = self.world["venue_a"]
        event = self.create_event("admin", venue, capacity=capacity)
        ttype = self.add_type("admin", venue, event["id"], quantity=type_quantity)
        self.publish("admin", venue, event["id"])
        alloc = self.set_allocation(
            "admin",
            venue,
            event["id"],
            ticket_type_id=ttype["id"],
            promoter_id=self.world["promoter"]["id"],
            capacity=alloc_capacity,
        )
        return {
            "venue": venue,
            "event": event["id"],
            "type": ttype["id"],
            "allocation": alloc,
        }

    # ------------------------------------------------------------------
    # Helpers de DB directa (cierre automatico, mig 020): ajustar columnas
    # que la API no expone (ends_at pasado) y ejecutar SQL suelto.
    # ------------------------------------------------------------------
    @property
    def dsn(self) -> str:
        return os.environ.get(
            "TEST_DATABASE_URL",
            "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
        )

    def run_sql(self, sql: str):
        """Ejecuta SQL suelto y devuelve el valor escalar de la primera fila.

        Tolera sentencias SIN resultado (UPDATE/INSERT sin RETURNING): antes
        un fetchone() sobre un UPDATE lanzaba ProgrammingError y mandaba a
        cero a media suite.
        """
        with psycopg.connect(self.dsn, autocommit=True, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
                try:
                    row = cur.fetchone()
                except psycopg.ProgrammingError:
                    return None
                return list(row.values())[0] if row else None

    def event_status(self, venue_id: int, event_id: int) -> str:
        """Status actual del evento leido directo de DB (fuera de la API)."""
        with psycopg.connect(self.dsn, autocommit=True, row_factory=dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM events WHERE id = %s", (event_id,))
                row = cur.fetchone()
                assert row, f"evento {event_id} no existe"
                return row["status"]


@pytest.fixture()
def api(api_client, world) -> Api:
    return Api(api_client, world)
