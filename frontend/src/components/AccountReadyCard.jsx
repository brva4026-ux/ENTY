import Icon from "./Icon";

/**
 * Primera llegada al panel después del alta.
 *
 * No es un modal: la persona ya tiene sesión y puede empezar a trabajar. La
 * tarjeta presenta el usuario generado, que es su credencial para volver a
 * entrar, y ofrece cambiarlo. Crear el primer evento vive en el estado vacío
 * de Eventos: una sola acción de creación a la vista.
 */
export default function AccountReadyCard({ user, onChangeUsername, onDismiss }) {
  const username = user?.username || "";

  return (
    <section
      className="account-ready card"
      aria-labelledby="account-ready-title"
    >
      <div className="account-ready-main">
        <span className="account-ready-icon" aria-hidden="true">
          <Icon name="check" className="h-5 w-5" />
        </span>
        <div className="account-ready-copy">
          <p className="account-ready-step">Primera entrada</p>
          <h2 id="account-ready-title" className="display">
            Tu cuenta está lista
          </h2>
          {username ? (
            <p className="account-ready-handle">
              Tu nombre de usuario es <strong>@{username}</strong>
            </p>
          ) : (
            <p className="account-ready-handle">
              Elige un nombre de usuario para entrar sin escribir el correo.
            </p>
          )}
          <p className="account-ready-hint">
            {username
              ? "Puedes usarlo para iniciar sesión y cambiarlo cuando quieras."
              : "Podrás cambiarlo cuando quieras desde tu perfil."}
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="account-ready-close"
            aria-label="Ocultar bienvenida"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        )}
      </div>

      <div className="account-ready-actions">
        <button
          type="button"
          onClick={onChangeUsername}
          className="btn-primary account-ready-action"
        >
          Cambiar usuario
          <Icon name="arrowRight" className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
