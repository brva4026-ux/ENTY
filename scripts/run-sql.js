// Envía un .sql al endpoint SQL de Supabase (Management API).
// Uso: node run-sql.js <archivo.sql>
// Requiere env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF
// Opcional: el endpoint acepta "read_only" implicito; el schema vive en public.
const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("uso: node run-sql.js <archivo.sql>");
  process.exit(1);
}
const raw = fs.readFileSync(file, "utf8");
const clean = raw
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("\\"))
  .join("\n");

const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!ref || !token) {
  console.error("Faltan SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF");
  process.exit(1);
}

(async () => {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: clean }),
    }
  );
  const text = await res.text();
  console.log("HTTP", res.status);
  console.log(text.slice(0, 1500));
  if (!res.ok) process.exit(2);
})();
