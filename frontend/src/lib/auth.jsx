import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const sessionAttempt = useRef(0);

  const restoreSession = useCallback(async () => {
    const attempt = ++sessionAttempt.current;
    setLoading(true);
    setSessionError(false);
    try {
      const me = await apiFetch("/auth/me");
      if (attempt !== sessionAttempt.current) return;
      // /me migra la credencial antigua a una cookie HttpOnly.
      localStorage.removeItem("tf_token");
      setUser(me);
    } catch (error) {
      if (attempt !== sessionAttempt.current) return;
      if (error.status === 401) {
        localStorage.removeItem("tf_token");
        setUser(null);
      } else {
        setSessionError(true);
      }
    } finally {
      if (attempt === sessionAttempt.current) setLoading(false);
    }
  }, []);

  useEffect(() => { restoreSession(); }, [restoreSession]);

  async function login(email, password) {
    ++sessionAttempt.current;
    setLoading(false);
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.removeItem("tf_token");
    setSessionError(false);
    setUser(data.user);
    return data.user;
  }

  async function register(payload) {
    ++sessionAttempt.current;
    setLoading(false);
    const data = await apiFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    localStorage.removeItem("tf_token");
    setSessionError(false);
    setUser(data.user);
    return data.user;
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    ++sessionAttempt.current;
    localStorage.removeItem("tf_token");
    setUser(null);
    // Marcar la salida INTENCIONAL: el guard de rutas ve user=null con la URL
    // vieja un instante (el update de location va en transicion) y siembra
    // from=ruta-actual en /login — el siguiente login aterrizaba en /perfil
    // (o donde fuera) en vez del panel del rol. Con la bandera, el guard
    // redirige a /login SIN state; la recuperación de sesión expirada y los
    // deep-links sí conservan su from (la bandera solo cubre este logout).
    _loggedOut = true;
  }

  return (
    <AuthContext.Provider value={{ user, loading, sessionError, restoreSession, login, register, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

/** Bandera de logout intencional (la consume el guard de main.jsx). */
let _loggedOut = false;
export function consumeLoggedOut() {
  const v = _loggedOut;
  _loggedOut = false;
  return v;
}

export function useAuth() {
  return useContext(AuthContext);
}
