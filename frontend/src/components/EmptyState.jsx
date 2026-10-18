import Icon from "./Icon";

/**
 * Estado vacío premium (patrón empty-state de distri-stream, en dark).
 *
 * La lista vacía es la primera impresión de un panel nuevo: un <p> suelto
 * se ve como "no funciona"; un icono en halo ultramar + título + texto se ve
 * como "todavía no hay nada, y así se resuelve".
 *
 * Props:
 * - icon: nombre del set de Icon.jsx (ej. "ticket", "users", "money")
 * - title: qué está vacío, en positivo ("Emití la primera boleta")
 * - children: texto de apoyo y/o CTA (<button className="btn-ghost">...)
 */
export default function EmptyState({ icon = "sparkle", title, children }) {
  return (
    <div className="empty-state animate-scale-in">
      <div className="empty-state-icon">
        <Icon name={icon} className="h-6 w-6" />
      </div>
      {title && <p className="empty-state-title">{title}</p>}
      {children && <div className="empty-state-text">{children}</div>}
    </div>
  );
}
