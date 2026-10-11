import { Link } from "react-router-dom";

/**
 * Barra inferior de la app del fan (mockup "1 · Inicio"): Inicio · Explorar ·
 * Boletos · Perfil. Vive aparte para que Inicio y Mis boletas compartan el
 * mismo shell sin duplicar los iconos.
 *
 * `active` marca la pestana encendida. Destinos de DESTINO, no de rol: el fan
 * no tiene cuenta, asi que Perfil cae en /login hasta que exista.
 */
const TABS = [
  { key: "inicio", label: "Inicio", to: "/inicio" },
  { key: "explorar", label: "Explorar", to: "/inicio" },
  { key: "boletos", label: "Boletos", to: "/boletas" },
  { key: "perfil", label: "Perfil", to: "/login" },
];

function NavIcon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  if (name === "inicio")
    return (
      <svg {...common}>
        <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
      </svg>
    );
  if (name === "explorar")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M15.5 8.5l-2 5-5 2 2-5z" />
      </svg>
    );
  if (name === "boletos")
    return (
      <svg {...common}>
        <path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
        <path d="M14 5v14" strokeDasharray="2 3" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  );
}

export default function FanNav({ active }) {
  return (
    <nav className="home-nav" aria-label="Navegación principal">
      {TABS.map((t) => (
        <Link key={t.key} to={t.to} className={t.key === active ? "is-on" : ""}>
          <NavIcon name={t.key} />
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
