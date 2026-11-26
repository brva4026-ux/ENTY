import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { globalSearch } from "../lib/api";
import { activeVenueId } from "../lib/venue";
import { useAuth } from "../lib/auth";
import Icon from "./Icon";

export default function GlobalSearch() {
  const { user } = useAuth();
  const nav = useNavigate();
  const venueId = activeVenueId(user);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setItems([]);
      setBusy(false);
      return;
    }
    let alive = true;
    setBusy(true);
    const timer = setTimeout(() => {
      globalSearch(text, venueId)
        .then((res) => {
          if (alive) {
            setItems(res.items || []);
            setActive(-1);
          }
        })
        .catch(() => alive && setItems([]))
        .finally(() => alive && setBusy(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, venueId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, []);

  function go(item) {
    setOpen(false);
    setQuery("");
    nav(item.url);
  }

  function onKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && active >= 0 && items[active]) {
      e.preventDefault();
      go(items[active]);
    }
  }

  return (
    <div className="admin-global-search" ref={rootRef}>
      <label className="admin-global-search-box">
        <Icon name="search" className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Buscar en el panel</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Buscar eventos, personas o acciones…"
          autoComplete="off"
        />
        {busy && <span className="admin-global-search-spin" aria-hidden="true" />}
      </label>
      {open && query.trim().length >= 2 && (
        <div className="admin-global-search-panel" role="listbox" aria-label="Resultados">
          {!items.length && !busy && (
            <p className="admin-global-search-empty">Sin resultados autorizados.</p>
          )}
          {items.map((item, index) => (
            <button
              key={`${item.kind}-${item.url}-${index}`}
              type="button"
              role="option"
              aria-selected={active === index}
              className={`admin-global-search-item${active === index ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => go(item)}
            >
              <span className="admin-global-search-kind">
                {item.kind === "event" ? "Evento" : item.kind === "person" ? "Persona" : "Acción"}
              </span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
