import { useEffect, useState } from "react";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";

const EMPTY = {
  eventName: "",
  typeName: "Elige una localidad",
  priceCents: 0,
  paymentMethod: "",
  status: "idle",
  updatedAt: 0,
};

export default function PosDisplayPage() {
  const params = new URLSearchParams(window.location.search);
  const eventId = params.get("evento");
  const [order, setOrder] = useState(EMPTY);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    forceDarkOnce();
  }, []);

  useEffect(() => {
    if (!eventId) return;
    const key = `tf_pos_display_${eventId}`;
    const read = () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          setOrder({ ...EMPTY, ...JSON.parse(raw) });
          setConnected(true);
        }
      } catch {
        /* almacenamiento privado */
      }
    };
    read();
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(`tf_pos_${eventId}`)
        : null;
    const onMessage = (event) => {
      if (event.data) {
        setOrder({ ...EMPTY, ...event.data });
        setConnected(true);
      }
    };
    const onStorage = (event) => {
      if (event.key === key) read();
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      window.removeEventListener("storage", onStorage);
    };
  }, [eventId]);

  return (
    <main className="pos-display">
      <header className="pos-display-head">
        <span className="pos-display-brand">ENTY</span>
        <span className="pos-display-live">
          <i aria-hidden="true" />
          {connected ? "Pantalla conectada" : "Esperando a taquilla"}
        </span>
      </header>

      <section className="pos-display-order" aria-live="polite">
        <p className="pos-display-kicker">Tu pedido</p>
        <h1>{order.eventName || "Bienvenido"}</h1>
        <div className="pos-display-line">
          <span>{order.typeName || "Elige una localidad"}</span>
          <strong>1</strong>
        </div>
        <div className="pos-display-total">
          <span>Total</span>
          <strong>{money(order.priceCents)}</strong>
        </div>
        {order.paymentMethod && (
          <p className="pos-display-method">
            Pago: {order.paymentMethod === "efectivo" ? "Efectivo" : "Transferencia"}
          </p>
        )}
        <p className="pos-display-status" data-status={order.status}>
          {order.status === "paid"
            ? "Pago recibido · boleta emitida"
            : order.status === "ready"
              ? "Revisa el pedido con el cajero"
              : "El cajero está preparando tu compra"}
        </p>
      </section>

      <footer className="pos-display-foot">
        Esta pantalla no muestra datos internos del cajero. Al terminar, la
        boleta llega a tu teléfono o se imprime en taquilla.
      </footer>
    </main>
  );
}
