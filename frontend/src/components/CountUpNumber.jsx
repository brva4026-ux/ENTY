/**
 * Número que cuenta: envoltorio visual de useCountUp. En un archivo aparte
 * porque el hook vive en .js puro (sin JSX) y así lo puede importar cualquier
 * módulo no-React.
 */
import { useCountUp } from "../lib/useCountUp";

export default function CountUpNumber({
  value,
  format = (v) => String(Math.round(v)),
  delay = 0,
  className,
}) {
  const v = useCountUp(value ?? 0, { delay });
  return <span className={className}>{format(v)}</span>;
}
