/** Une sede y dirección sin repetir el nombre cuando la dirección ya lo
 *  incluye ("Bodega 45 · Bodega 45, Calle 45" -> "Bodega 45, Calle 45"). */
export function placeLabel(venue, location) {
  const v = (venue || "").trim();
  const l = (location || "").trim();
  if (!v) return l;
  if (!l) return v;
  const norm = (s) =>
    s
      .toLocaleLowerCase("es")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  if (norm(l).includes(norm(v))) return l;
  if (norm(v).includes(norm(l))) return v;
  return `${v} · ${l}`;
}
