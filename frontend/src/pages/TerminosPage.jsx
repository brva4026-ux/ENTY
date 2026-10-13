import { LegalLayout } from "../components/LegalLayout";
import { SITE } from "../lib/site";

/**
 * Términos y condiciones de Enty. Texto base honesto sobre lo que la app hace
 * hoy; revísalo con asesoría legal antes de cobrar de verdad (ver el comentario
 * en LegalLayout.jsx). No promete funciones que no existan.
 */
export default function TerminosPage() {
  return (
    <LegalLayout
      title="Términos y condiciones"
      intro={`Estos términos rigen el uso de ${SITE.name}, la plataforma de venta de boletas y control de acceso a eventos. Al crear una cuenta o usar el servicio, aceptas lo que sigue.`}
    >
      <section>
        <h2>1. Qué es {SITE.name}</h2>
        <p>
          {SITE.name} es una herramienta para que organizadores de eventos
          vendan boletas, administren cupos y controlen la entrada en la puerta.
          El organizador crea su espacio, publica sus eventos y gestiona a su
          equipo; el público compra o recibe boletas y las presenta al ingresar.
        </p>
      </section>

      <section>
        <h2>2. Cuentas y roles</h2>
        <p>
          Las cuentas con acceso a la administración (organizador, promotor y
          personal de puerta) son personales y requieren credenciales. Eres
          responsable de la actividad que ocurra con tu cuenta y de mantener tu
          contraseña a salvo. Los asistentes pueden usar boletas y listas de
          espera sin crear una cuenta.
        </p>
      </section>

      <section>
        <h2>3. Eventos, cupos y boletas</h2>
        <p>
          El organizador define la capacidad del evento, los tipos de boleta y
          los cupos. Cada boleta corresponde a una entrada y se emite con un
          código único. El organizador es responsable de la veracidad de la
          información de su evento (fecha, lugar, precio y condiciones).
        </p>
      </section>

      <section>
        <h2>4. Pagos</h2>
        <p>
          Los pagos se procesan a través de la pasarela de pagos habilitada por
          el organizador. {SITE.name} no almacena datos de tarjetas. Las
          condiciones de precio, reembolso y devolución las define el
          organizador del evento y deben mostrarse al comprador antes de pagar.
        </p>
      </section>

      <section>
        <h2>5. Acceso en la puerta</h2>
        <p>
          Cada boleta se valida una sola vez. El código se activa para su uso
          cerca del inicio del evento y, una vez ingresado, queda marcado como
          usado. Compartir o reenviar tu boleta puede impedirte el ingreso si
          otra persona la usa primero.
        </p>
      </section>

      <section>
        <h2>6. Uso aceptable</h2>
        <p>
          No está permitido usar el servicio para actividades ilícitas,
          suplantar a otras personas, revender boletas en contra de las
          condiciones del organizador, ni interferir con el funcionamiento de la
          plataforma o con el acceso de otros usuarios.
        </p>
      </section>

      <section>
        <h2>7. Contenido y datos del organizador</h2>
        <p>
          El organizador conserva la titularidad de la información de sus
          eventos y de los datos de sus asistentes, y es responsable de tratarlos
          conforme a la ley. {SITE.name} los trata únicamente para prestar el
          servicio, según la Política de privacidad.
        </p>
      </section>

      <section>
        <h2>8. Disponibilidad y responsabilidad</h2>
        <p>
          Trabajamos para que el servicio esté disponible, pero no garantizamos
          que sea ininterrumpido ni libre de errores. En la medida que permita la
          ley, {SITE.name} no responde por daños indirectos derivados del uso del
          servicio; el organizador responde frente a sus asistentes por la
          realización del evento.
        </p>
      </section>

      <section>
        <h2>9. Cambios</h2>
        <p>
          Podemos actualizar estos términos para reflejar cambios del servicio o
          de la ley. Publicaremos la versión vigente en esta página con su fecha
          de actualización. Si el cambio es relevante, lo avisaremos por los
          canales de contacto disponibles.
        </p>
      </section>

      <section>
        <h2>10. Contacto y ley aplicable</h2>
        <p>
          Para preguntas sobre estos términos, escribe a{" "}
          <a className="legal-link" href={`mailto:${SITE.legalEmail}`}>
            {SITE.legalEmail}
          </a>
          . Se aplican las leyes del país donde opera el organizador que presta
          el servicio a los asistentes.
        </p>
      </section>
    </LegalLayout>
  );
}
