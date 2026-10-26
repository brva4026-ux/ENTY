import { useNavigate, useSearchParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { missingList } from "../lib/passwordPolicy";
import { Logo } from "../components/Brand";
import PasswordMeter from "../components/PasswordMeter";
import useDocumentTitle from "../lib/useDocumentTitle";
import { withViewTransition } from "../lib/viewTransition";

/**
 * Reset self-service: el usuario llega desde el correo con ?token=...
 * (GET del link: el token viaja en la URL pero es de un solo uso y vence en
 * 60 min — el correo es el canal privado del usuario, no la app).
 * Canjea el token por una contraseña nueva con la política completa.
 */
export default function ResetPasswordPage() {
  useDocumentTitle("Nueva contraseña");
  const [searchParams] = useSearchParams();
  const nav = useNavigate();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const issues = useMemo(() => missingList(password), [password]);

  async function submit(e) {
    e.preventDefault();
    if (issues.length > 0) {
      setError(`A la contraseña le falta: ${issues.join(", ")}.`);
      return;
    }
    setError("");
    setBusy(true);
    try {
      await apiFetch("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, new_password: password }),
      });
      setDone(true);
    } catch (err) {
      setError(err?.message || "No pudimos actualizar la contraseña.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size="lg" />
          <p className="mt-3 text-sm text-zinc-500">Recuperación de acceso</p>
        </div>

        <div className="card card-interactive reveal p-6">
          {!token ? (
            <>
              <h1 className="display mb-2 text-lg">Enlace incompleto</h1>
              <p className="text-sm leading-relaxed text-zinc-400">
                Este enlace no trae el código de recuperación. Abre el enlace
                completo desde tu correo, o pide uno nuevo desde la pantalla
                de ingreso.
              </p>
              <button onClick={() => withViewTransition(() => nav("/login"))} className="btn-primary mt-4 w-full">
                Ir a ingresar
              </button>
            </>
          ) : done ? (
            <>
              <h1 className="display mb-2 text-lg">Contraseña actualizada</h1>
              <p className="text-sm leading-relaxed text-zinc-400">
                Ya puedes iniciar sesión con tu nueva contraseña.
              </p>
              <button onClick={() => withViewTransition(() => nav("/login"))} className="btn-primary mt-4 w-full">
                Ingresar
              </button>
            </>
          ) : (
            <>
              <h1 className="display mb-1 text-lg">Nueva contraseña</h1>
              <p className="eyebrow mb-5">Vence en 60 minutos · un solo uso</p>

              <form onSubmit={submit}>
                <label
                  htmlFor="reset-pass"
                  className="mb-1.5 block text-xs font-medium text-zinc-400"
                >
                  Tu nueva contraseña
                </label>
                <div className="relative mb-2">
                  <input
                    id="reset-pass"
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                    className="field mb-0 !pr-16"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
                    aria-label={showPass ? "Ocultar contraseña" : "Mostrar contraseña"}
                  >
                    {showPass ? "Ocultar" : "Ver"}
                  </button>
                </div>

                {password && <PasswordMeter value={password} />}

                {error && (
                  <div
                    role="alert"
                    className="mb-4 mt-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm leading-relaxed text-red-300"
                  >
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy || issues.length > 0}
                  className="btn-primary mt-2 w-full"
                >
                  {busy && (
                    <svg className="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  )}
                  {busy ? "Guardando…" : "Guardar contraseña"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
