"""Email transaccional via Resend: HTTP puro con urllib (stdlib).

Cero dependencias nuevas en la función serverless (el incidente
FUNCTION_INVOCATION_FAILED por import roto manda: nada de SDKs). Sin
RESEND_API_KEY todo es no-op: la app funciona igual y `email_enabled` lo
dice en /health. Cuando el dueño pegue la key en Vercel, el email se
enciende solo, sin deploy.

El envío es síncrono y el llamador lo corre en threadpool: los emails de
este sistema son de alta latencia y baja volumen (resets, invitaciones),
nunca de respuesta de request en caliente salvo el reset mismo — donde el
usuario está esperando el correo y un segundo más no rompe nada. Un fallo
de envío NUNCA debe romper la operación de negocio: se captura, se reporta
a Sentry y el flujo continúa (el usuario puede pedir el email de nuevo).
"""
import json
import urllib.request

from app.core.observability import capture_exception


class Mailer:
    """Cliente mínimo de Resend (POST /emails). No-op sin API key."""

    def __init__(self, api_key: str, from_email: str, from_name: str, app_url: str):
        self.api_key = api_key
        self.from_email = from_email
        self.from_name = from_name
        self.app_url = app_url

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _send(self, *, to: str, subject: str, html: str) -> bool:
        """Envía y devuelve True/False. Nunca lanza hacia afuera."""
        if not self.enabled:
            return False
        try:
            body = json.dumps({
                "from": f"{self.from_name} <{self.from_email}>",
                "to": [to],
                "subject": subject,
                "html": html,
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://api.resend.com/emails",
                data=body,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status in (200, 201)
        except Exception as e:
            # El correo que no sale es un incidente visible, no un crash.
            capture_exception(e, context={"component": "mailer", "to": to, "subject": subject})
            return False

    # ------------------------------------------------------------------
    # Plantillas
    # ------------------------------------------------------------------

    def send_password_reset(self, *, to: str, full_name: str, token: str) -> bool:
        """Correo de reset: link con el token crudo en la ruta de la página
        /reset. Vence en 60 minutos y muere al usarse."""
        link = f"{self.app_url}/reset?token={token}"
        name = (full_name or "").strip().split(" ")[0] or "hola"
        html = f"""\
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 8px;font-size:20px">Recupera tu acceso</h2>
  <p style="margin:0 0 16px;color:#555;font-size:14px">
    Hola {name}, recibimos una solicitud para restablecer tu contraseña en TicketFlow.
  </p>
  <p style="margin:0 0 24px">
    <a href="{link}"
       style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block">
      Restablecer contraseña
    </a>
  </p>
  <p style="margin:0 0 8px;color:#777;font-size:13px">
    El enlace vence en 60 minutos y solo se puede usar una vez.
  </p>
  <p style="margin:0;color:#999;font-size:12px">
    Si no fuiste tú, ignora este correo: tu contraseña sigue igual.
  </p>
</div>"""
        return self._send(
            to=to,
            subject="Recupera tu contraseña · TicketFlow",
            html=html,
        )

    def send_invitation(self, *, to: str, full_name: str, venue_name: str, link: str) -> bool:
        """Invitación al equipo: reaprovecha el token de staff_invitations."""
        html = f"""\
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 8px;font-size:20px">Te invitaron a {venue_name}</h2>
  <p style="margin:0 0 16px;color:#555;font-size:14px">
    Hola {full_name}, te invitaron a colaborar en <strong>{venue_name}</strong> con TicketFlow,
    el sistema de boletería y control de puerta.
  </p>
  <p style="margin:0 0 24px">
    <a href="{link}"
       style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block">
      Aceptar invitación
    </a>
  </p>
  <p style="margin:0;color:#999;font-size:12px">
    Si no esperabas este correo, simplemente ignóralo.
  </p>
</div>"""
        return self._send(to=to, subject=f"Te invitaron a {venue_name} · TicketFlow", html=html)
