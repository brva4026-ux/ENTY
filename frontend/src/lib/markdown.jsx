/**
 * Render de markdown mínimo, sin dependencias.
 *
 * Por qué existe: los documentos legales son texto largo que revisa un abogado,
 * así que la copia canónica vive en backend/app/assets/legal/*.md y la API la
 * sirve. Traer una librería de markdown completa para cinco documentos estáticos
 * no se justifica (y una librería nueva es superficie que hay que mantener). Este
 * render cubre exactamente lo que esos documentos usan: encabezados, párrafos,
 * listas, tablas, citas, reglas horizontales y negrita/cursiva/código/enlaces.
 *
 * Si algún día los documentos necesitan más sintaxis, se agrega aquí y se
 * verifica contra los archivos reales.
 */

const INLINE =
  /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;

function inline(text, keyPrefix) {
  return text
    .split(INLINE)
    .filter((part) => part !== "")
    .map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return <code key={key}>{part.slice(1, -1)}</code>;
      }
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        return (
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer noopener"
            className="text-brand-300 underline decoration-brand-300/40 underline-offset-2 hover:text-brand-200"
          >
            {link[1]}
          </a>
        );
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        return <em key={key}>{part.slice(1, -1)}</em>;
      }
      return part;
    });
}

/** Corta las celdas de una fila de tabla: `| a | b |` -> ["a","b"]. */
function cells(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparatorRow(row) {
  return /^\|?[\s:|-]+\|?$/.test(row ?? "") && (row ?? "").includes("-");
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      out.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ type: "h", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    const sep = line.trimStart().startsWith("|") ? 1 : 0;
    if (line.trimStart().startsWith("|") && isSeparatorRow(lines[i + sep])) {
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      out.push({ type: "table", header, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push({ type: "quote", text: quote.join(" ") });
      continue;
    }

    const bullet = /^\s*[-*]\s+/.exec(line);
    const ordered = /^\s*(\d+)\.\s+/.exec(line);
    if (bullet || ordered) {
      const items = [];
      const pattern = bullet ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
      while (i < lines.length) {
        const m = pattern.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      out.push({ type: "list", ordered: Boolean(ordered), items });
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith("|")
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length) out.push({ type: "p", text: paragraph.join(" ") });
  }
  return out;
}

export function Markdown({ text }) {
  const parsed = blocks(String(text ?? "").replace(/\r\n/g, "\n").split("\n"));
  // Cada tabla con scroll es un `region`; dos regiones con el mismo nombre
  // accesible violan landmark-unique, así que se numeran.
  let tableCount = 0;

  return (
    <div className="legal-doc">
      {parsed.map((b, i) => {
        const key = `b-${i}`;
        switch (b.type) {
          case "hr":
            return <hr key={key} className="legal-hr" />;
          case "h": {
            const Tag = b.level === 1 ? "h1" : b.level === 2 ? "h2" : "h3";
            return (
              <Tag key={key} className={`legal-h${b.level}`}>
                {inline(b.text, key)}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={key} className="legal-quote">
                {inline(b.text, key)}
              </blockquote>
            );
          case "list":
            return b.ordered ? (
              <ol key={key} className="legal-ol">
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="legal-ul">
                {b.items.map((it, j) => (
                  <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "table": {
            // Tabla ancha -> scroll horizontal propio: la página nunca se
            // desborda en móvil (el invitado y el dueño del bar leen en celular).
            // `tabIndex=0` + `role=region` con nombre: un contenedor con scroll
            // debe poder alcanzarse con el teclado (WCAG 2.1.1); sin esto, quien
            // navega con teclado no puede desplazarlo. Si la cabecera del markdown
            // viene vacía (`| | |`), no se emite <thead>: una celda de encabezado
            // sin texto es una violación (empty-table-header).
            const hasHeader = b.header.some((h) => String(h ?? "").trim() !== "");
            const tableNo = (tableCount += 1);
            return (
              <div
                key={key}
                className="legal-table-wrap"
                tabIndex={0}
                role="region"
                aria-label={`Tabla de datos ${tableNo}`}
              >
                <table className="legal-table">
                  {hasHeader && (
                    <thead>
                      <tr>
                        {b.header.map((h, j) => (
                          <th key={`${key}-h-${j}`} scope="col">
                            {inline(h, `${key}-h-${j}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={`${key}-r-${j}`}>
                        {row.map((c, k) => (
                          <td key={`${key}-r-${j}-${k}`}>
                            {inline(c, `${key}-r-${j}-${k}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default:
            return (
              <p key={key} className="legal-p">
                {inline(b.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
