import { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("tf_token");
    if (!token) {
      setLoading(false);
      return;
    }
    apiFetch("/auth/me")
      .then((me) => setUser(me))
      .catch(() => {
        localStorage.removeItem("tf_token");
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem("tf_token", data.access_token);
    setUser(data.user);
    return data.user;
  }

  async function register(payload) {
    const data = await apiFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    localStorage.setItem("tf_token", data.access_token);
    setUser(data.user);
    return data.user;
  }

  function logout() {
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
    <AuthContext.Provider value={{ user, loading, login, register, logout, setUser }}>
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