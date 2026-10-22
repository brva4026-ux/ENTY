/**
 * DashboardCover - Portada profesional de TicketFlow
 * Diseño: Opción 1 - Dashboard con resumen rápido y acciones directas
 * 
 * Features:
 * - Resumen estadístico con números grandes
 * - CTA principal: ABRIR PUERTAS / PUBLICAR EVENTO
 * - Lista de eventos con badges de estado
 * - Últimos scaneros con estados ✅/❌
 * - Grid responsivo
 */

import React from "react";
import { FaQrcode, FaCheckCircle, FaTimesCircle, FaArrowUp } from "react-icons/fa";
import "./DashboardCover.css";

// Datos de ejemplo - en producción vendrían del useQuery o useSelector
const stats = [
  { label: "Eventos activos", value: 2, icon: FaArrowUp, trend: "+12%" },
  { label: "Cupo total", value: 240, icon: null, trend: null },
  { label: "Vendidos", value: 187, icon: FaCheckCircle, trend: "+15 this week" },
  { label: "Disponibles", value: 53, icon: FaTimesCircle, trend: "-8 this week" },
];

const recentScans = [
  { id: 1, ticketType: "General", status: "validated", timestamp: "2 min ago", user: "Promo 1" },
  { id: 2, ticketType: "Cortesia", status: "voided", timestamp: "15 min ago", user: "Door" },
  { id: 3, ticketType: "General", status: "validated", timestamp: "45 min ago", user: "Promo 2" },
  { id: 4, ticketType: "Promo", status: "redeemed", timestamp: "2h ago", user: "Bouncer" },
];

export default function DashboardCover() {
  return (
    <div className="dashboard-cover min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <FaQrcode className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              TICKETFLOW
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {new Date().toLocaleDateString("es-ES", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
            <button
              className="hidden sm:block bg-primary text-white rounded-full px-3 py-1 text-sm font-medium"
            >
              Ver perfil
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6">

        {/* Stats Section */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="group rounded-lg border p-5 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:shadow-lg hover:border-primary transition-all duration-300"
            >
              <div className="flex items-start gap-3">
                {stat.icon ? (
                  <div className="mt-1 flex-shrink-0">
                    <stat.icon
                      className={`w-6 h-6 ${
                        stat.trend?.includes("+") ? "text-primary" : stat.status === "validated" ? "text-green-500" : "text-red-500"
                      }`}
                    />
                  </div>
                ) : null}
                <div className="flex-1 pt-1">
                  <p className="text-sm text-gray-500 dark:text-gray-400 group-hover:text-primary transition-colors">
                    {stat.label}
                  </p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                    {stat.value}
                  </p>
                </div>
              </div>
              {/* Trend badge solo para stats de ventas */
              {stat.trend && stat.trend.includes("+") && (
                <div className="mt-2 text-xs font-medium text-green-600">
                  {stat.trend}
                </div>
              )}
            </div>
          ))}
        </section>

        {/* CTA Section */}
        <section className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            className="col-span-2 sm:col-span-1 bg-primary text-white rounded-lg px-6 py-4 font-semibold text-lg shadow-lg hover:opacity-90 transition-opacity"
          >
            🚀 ABRIR PUERTAS
          </button>
          <button
            className="sm:col-span-1 bg-white text-gray-800 rounded-lg border border-gray-300 px-6 py-4 font-semibold text-lg shadow-sm hover:bg-gray-50 transition-colors"
          >
            📝 PUBLICAR EVENTO
          </button>
        </section>

        {/* Events Section */}
        <section className="mt-8 space-y-4">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            📅 TUS EVENTOS
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {/* Event Card 1 - Live */
            <div
              className="
                rounded-lg border overflow-hidden bg-white dark:bg-gray-800
                hover:shadow-xl transition-shadow
              "
            >
              <div className="p-4 flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    Noche Electronica
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Hoy · 9:00 PM
                  </p>
                </div>
                <span
                  className="
                    inline-flex items-center rounded-full bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5
                  "
                >
                  LIVE
                </span>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Capacity: 120 | Sold: 115 (96%)
                </p>
                <p className="text-xs text-green-600 font-medium">
                  ▶️ ABRIR PUERTAS
                </p>
              </div>
            </div>

            {/* Event Card 2 - Draft */
            <div
              className="
                rounded-lg border overflow-hidden bg-white dark:bg-gray-800
                hover:shadow-xl transition-shadow
              "
            >
              <div className="p-4 flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    Fiesta Promo - Borrador
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    En draft · Sin fecha
                  </p>
                </div>
                <span
                  className="
                    inline-flex items-center rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium px-2.5 py-0.5
                  "
                >
                  DRAFT
                </span>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Types: Cortesia (50) · General (30.000)
                </p>
              </div>
            </div>

            {/* Event Card 3 - Upcoming */
            <div
              className="
                rounded-lg border overflow-hidden bg-white dark:bg-gray-800
                hover:shadow-xl transition-shadow
              "
            >
              <div className="p-4 flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    Cena de Gala
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    En 3 días · 80/100
                  </p>
                </div>
                <span
                  className="
                    inline-flex items-center rounded-full bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5
                  "
                >
                  UPCOMING
                </span>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  $45.000 · 80% ocupación
                </p>
              </div>
            </div>

            {/* Event Card 4 - Ended */
            <div
              className="
                rounded-lg border overflow-hidden bg-white dark:bg-gray-800
                hover:shadow-xl transition-shadow
              "
            >
              <div className="p-4 flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    Evento Anterior
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Finalizado hace 2 semanas
                  </p>
                </div>
                <span
                  className="
                    inline-flex items-center rounded-full bg-gray-200 text-gray-600 text-xs font-medium px-2.5 py-0.5
                  "
                >
                  ENDED
                </span>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  450 asistentes · $12.000.000 revenue
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Recent Scans Section */}
        <section className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            📡 ÚLTIMOS SCANEOS
          </h2>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {recentScans.map((scan) => {
              const statusClass =
                scan.status === "validated"
                  ? "bg-green-100 text-green-800"
                  : scan.status === "voided"
                  ? "bg-red-100 text-red-800"
                  : "bg-blue-100 text-blue-800";

              const statusIcon =
                scan.status === "validated"
                  ? <FaCheckCircle className="w-4 h-4" />
                  : scan.status === "voided"
                  ? <FaTimesCircle className="w-4 h-4" />
                  : <FaArrowUp className="w-4 h-4";

              return (
                <div key={scan.id} className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-medium">
                      {scan.ticketType.charAt(0)}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
                      {scan.ticketType} - {scan.user}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
                      {scan.timestamp}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded ${statusClass} text-xs font-medium px-2.5 py-0.5`}
                  >
                    {scan.status === "validated"
                      ? "VALIDADO"
                      : scan.status === "voided"
                      ? "VOIDED"
                      : "REDEEMPTED"
                  }
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}