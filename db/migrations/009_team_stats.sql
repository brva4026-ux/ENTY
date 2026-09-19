-- 009: métricas de equipo (productividad por persona) y último acceso.
--
-- last_login_at: alimenta el indicador de actividad del módulo Equipo. Es
-- null para cuentas nunca usadas — la UI lo distingue de un acceso antiguo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Índice para el ordenamiento por actividad del listado del equipo.
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users (last_login_at);
