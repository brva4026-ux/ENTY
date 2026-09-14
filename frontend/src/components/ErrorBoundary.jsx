import React from "react";

/**
 * ErrorBoundary global: si un componente interno falla (p.ej. un .map sobre
 * un dato inesperado), muestra el error en pantalla en lugar de una página
 * en blanco. Facilita el debug en producción y en el celular.
 */
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6 text-center">
          <h1 className="text-xl font-bold text-white">Ocurrió un error</h1>
          <p className="mt-2 max-w-md break-words text-sm text-red-300">
            {String(this.state.error?.message || this.state.error)}
          </p>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.href = "/";
            }}
            className="mt-6 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400"
          >
            Volver al inicio
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}