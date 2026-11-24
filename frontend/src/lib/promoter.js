import { eventDate, money } from "./format";

export const CHANNEL_LABELS = {
  promoter_link: "Link",
  promoter_quota: "Cupo",
  promoter_direct: "Venta directa",
  venue: "Taquilla",
  public: "Pública",
};

export const PAYMENT_LABELS = {
  confirmed: "Confirmado",
  reported: "Reportado",
  review: "En revisión",
  not_required: "No requiere",
  refunded: "Reembolsado",
  voided: "Anulado",
};

export const ADMISSION_LABELS = {
  pending: "Sin usar",
  validated: "Usada",
  invalid: "Inválida",
};

export const SALE_REASON_LABELS = {
  assignment_removed: "Tu asignación a este evento fue retirada.",
  not_open: "La venta aún no está abierta.",
  ended: "El evento ya terminó.",
  cancelled: "El evento fue cancelado.",
  no_types: "El evento todavía no tiene tipos de boleta.",
  sold_out: "No quedan boletas disponibles.",
};

export const EVENT_STATUS_LABELS = {
  draft: "Borrador",
  published: "Publicado",
  live: "En vivo",
  ended: "Finalizado",
  cancelled: "Cancelado",
};

export const PAYOUT_STATUS_LABELS = {
  pending: "Pendiente",
  paid: "Pagada",
  disputed: "En revisión",
  rejected: "Rechazada",
  voided: "Anulada",
};

export function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || channel || "Venta";
}

export function paymentLabel(state) {
  return PAYMENT_LABELS[state] || state || "—";
}

export function admissionLabel(state) {
  return ADMISSION_LABELS[state] || state || "—";
}

export function payoutStatusLabel(state) {
  return PAYOUT_STATUS_LABELS[state] || state || "—";
}

export function eventStatusLabel(status) {
  return EVENT_STATUS_LABELS[status] || status || "—";
}

export function saleReasonLabel(reason) {
  return SALE_REASON_LABELS[reason] || "Este evento no está disponible para vender.";
}

export function paymentClass(state) {
  if (state === "confirmed" || state === "not_required") return "ok";
  if (state === "review") return "warn";
  if (state === "refunded" || state === "voided") return "danger";
  return "neutral";
}

export function admissionClass(state) {
  if (state === "validated") return "ok";
  if (state === "invalid") return "danger";
  return "neutral";
}

export function payoutClass(status) {
  if (status === "paid") return "ok";
  if (status === "pending") return "warn";
  if (status === "disputed" || status === "rejected") return "danger";
  return "neutral";
}

export function priceLabel(cents, currency = "COP") {
  if (cents === 0) return "Gratis";
  return money(cents, currency);
}

export function eventWhen(iso) {
  return iso ? eventDate(iso) : "Fecha por confirmar";
}

export function shortTicket(ticketId) {
  return `#${String(ticketId ?? "").padStart(4, "0")}`;
}

export function waDigits(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits : "";
}

export function ticketShareUrl(token) {
  if (!token) return "";
  return `${window.location.origin}/t#${token}`;
}

export function ticketMessage({ customerName, eventName, ticketId, url }) {
  return [
    `Hola ${customerName || ""}`.trim() + "!",
    `Aquí está tu boleta para ${eventName || "el evento"}.`,
    ticketId ? `Boleta ${shortTicket(ticketId)}.` : null,
    url ? `Ábrela y guarda el QR: ${url}` : null,
    "",
    "Preséntala en la puerta. Si no puedes abrirla, escríbeme por aquí.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function initialsOf(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function availableSummary(types = []) {
  return types
    .filter((t) => t.is_active)
    .map((t) => `${t.name}: ${t.available} disp.`)
    .join(" · ");
}
