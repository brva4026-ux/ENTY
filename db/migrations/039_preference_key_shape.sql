-- 039: el CHECK de `user_preferences.key` pasa de lista cerrada a forma.
--
-- Problema: el CHECK enumeraba ('onboarding', 'tutorial'), así que cada
-- preferencia nueva exigía una migración para relajar el guardarraíl. La
-- intención original era buena ("la tabla es del producto, no un cajón"), pero
-- el efecto fue que la tabla creciera a golpe de migración en vez de a golpe
-- de código.
--
-- Decisión: el CHECK pasa a validar la FORMA de la clave (minúsculas, dígitos
-- y guion bajo, empezando por letra, hasta 41 caracteres). Sigue siendo un
-- guardarraíl —nada de strings arbitrarios ni espacios— pero una preferencia
-- nueva se agrega en el código, sin tocar la base. El catálogo de claves que
-- el producto acepta sigue viviendo en la API (`PreferenceKey`), que es su
-- lugar: la DB cuida la forma, el producto cuida el catálogo.
--
-- Idempotente: se puede re-ejecutar (DROP IF EXISTS + ADD). Las claves ya
-- guardadas ('onboarding', 'tutorial') cumplen la forma, así que la
-- validación de las filas existentes pasa sin cambios.

BEGIN;

ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_key_check;
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_key_check
    CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$');

COMMIT;
