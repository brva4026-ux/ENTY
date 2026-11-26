"""SEO técnico: sitemap y robots (mig 075).

La SPA no puede generar un sitemap por sí sola y los buscadores necesitan una
lista estable de fichas públicas. Solo entran eventos publicados o en vivo y
con fecha futura: un borrador o un evento terminado no debe indexarse.
"""
from datetime import datetime, timezone
from html import escape

from fastapi import APIRouter, Depends, Response
from fastapi.responses import PlainTextResponse

from app.core.config import get_settings
from app.core.db import get_db

router = APIRouter(tags=["seo"], include_in_schema=False)


@router.get("/sitemap.xml")
async def sitemap(db=Depends(get_db)):
    settings = get_settings()
    base = settings.app_public_url.rstrip("/")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT id, updated_at
              FROM events
             WHERE status IN ('published', 'live')
               AND starts_at >= now() - interval '1 day'
             ORDER BY starts_at
             LIMIT 5000
            """
        )
        rows = await cur.fetchall()

    urls = [f"{base}/", f"{base}/eventos"]
    entries = []
    for r in rows:
        event_url = f"{base}/evento/{r['id']}"
        updated = (r["updated_at"] or datetime.now(timezone.utc)).isoformat()
        entries.append(
            f"  <url><loc>{escape(event_url)}</loc>"
            f"<lastmod>{updated}</lastmod>"
            "<changefreq>daily</changefreq><priority>0.8</priority></url>"
        )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(f"  <url><loc>{escape(u)}</loc></url>" for u in urls)
        + ("\n" + "\n".join(entries) if entries else "")
        + "\n</urlset>\n"
    )
    return Response(
        content=body,
        media_type="application/xml",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/robots.txt", response_class=PlainTextResponse)
async def robots():
    base = get_settings().app_public_url.rstrip("/")
    return PlainTextResponse(
        "\n".join(
            [
                "User-agent: *",
                "Allow: /",
                "Disallow: /admin",
                "Disallow: /mis-boletas",
                "Disallow: /t/",
                "Disallow: /api/",
                f"Sitemap: {base}/sitemap.xml",
                "",
            ]
        ),
        headers={"Cache-Control": "public, max-age=3600"},
    )
