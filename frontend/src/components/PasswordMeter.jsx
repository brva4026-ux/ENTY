/**
 * Medidor de contraseña con checklist en vivo: cada requisito ✓/✗ mientras
 * se escribe. Reemplaza adivinar por leer — el patrón que usan los productos
 * con buen onboarding (GitHub, Stripe).
 */
import { checklist } from "../lib/passwordPolicy";
import Icon from "./Icon";

export default function PasswordMeter({ value, idPrefix }) {
  const items = checklist(value);
  return (
    <ul id={idPrefix ? `${idPrefix}-reqs` : undefined} className="mb-4 mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
      {items.map((it) => (
        <li
          key={it.label}
          className={`flex items-center gap-1.5 text-xs transition-colors ${
            it.ok ? "text-emerald-400" : "text-zinc-500"
          }`}
          aria-invalid={!it.ok}
        >
          <Icon
            name={it.ok ? "check" : "close"}
            className={`h-3.5 w-3.5 shrink-0 ${it.ok ? "" : "opacity-50"}`}
          />
          <span className={it.ok ? "line-through decoration-emerald-700/60" : ""}>
            {it.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
