import { LegalLayout } from "../components/LegalLayout";
import { SITE } from "../lib/site";

/**
 * Política de privacidad de Enty. Describe los datos que la app REALMENTE
 * trata hoy (cuentas, boletas, puerta, pagos vía pasarela, almacenamiento
 * local). No es un texto genérico: cada sección corresponde a un dato que
 * existe en el modelo. Revísalo con asesoría legal antes de producción.
 */
export default function PrivacidadPage() {
  return (
    <LegalLayout
      title="Política de privacidad"
      intro={`Esta política explica qué datos trata ${SITE.name}, para qué los usa y qué control tienes sobre ellos, tanto si administras eventos como si solo compras una boleta.`}
    >
      <section>
        <h2>1. Responsables</h2>
        <p>
          {SITE.name} presta la plataforma. El organizador del evento es el
          responsable de los datos de sus asistentes y define para qué los usa
          dentro de las funciones del servicio. {SITE.name} los trata como
          encargado, únicamente para operar la venta, la boleta y el acceso.
        </p>
      </section>

      <section>
        <h2>2. Qué datos tratamos</h2>
        <ul>
          <li>
            <strong>Cuentas del equipo:</strong> nombre, correo, contraseña
            (guardada solo como hash, nunca en claro) y rol dentro del evento.
          </li>
          <li>
            <strong>Asistentes y boletas:</strong> nombre, teléfono y, si se
            indica, correo del invitado; el tipo de boleta y su estado.
          </li>
          <li>
            <strong>Lista de espera:</strong> nombre y teléfono para avisarte
            cuando se libere un lugar.
          </li>
          <li>
            <strong>Puerta:</strong> qué boleta se validó, cuándo y por quién,
            para evitar el reuso y para el reporte del evento.
          </li>
          <li>
            <strong>Pagos:</strong> la pasarela procesa el cobro; {SITE.name} no
            almacena datos de tarjetas, solo la referencia y el monto de la
            transacción.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. Para qué los usamos</h2>
        <p>
          Para emitir y validar boletas, controlar el aforo, avisarte sobre tu
          lista de espera, enviar correos del servicio (recuperar contraseña,
          invitaciones al equipo) y mostrarte a los organizadores los reportes
          de su evento. No usamos los datos de asistentes para publicidad de
          terceros.
        </p>
      </section>

      <section>
        <h2>4. Almacenamiento en tu dispositivo</h2>
        <p>
          Usamos el almacenamiento local del navegador para recordar tu sesión
          del equipo, tu tema, tus favoritos y, en la puerta, una cola de
          escaneos para poder validar sin conexión y sincronizar después. No
          son cookies de publicidad.
        </p>
      </section>

      <section>
        <h2>5. Con quién se comparten</h2>
        <p>
          Compartimos lo mínimo con los proveedores que hacen posible el
          servicio: la pasarela de pagos (cobro), el proveedor de correo
          transaccional y el de monitoreo de errores. No vendemos datos
          personales. El organizador ve los datos de las boletas y del acceso de
          su propio evento.
        </p>
      </section>

      <section>
        <h2>6. Cuánto tiempo</h2>
        <p>
          Conservamos los datos de la cuenta mientras exista y los de boletas y
          accesos durante el tiempo necesario para la operación y para cumplir
          obligaciones legales o contables. Después se eliminan o anonimizan.
        </p>
      </section>

      <section>
        <h2>7. Tus derechos</h2>
        <p>
          Puedes solicitar acceso, corrección o eliminación de tus datos, y
          oponerte a un tratamiento, escribiendo a{" "}
          <a className="legal-link" href={`mailto:${SITE.legalEmail}`}>
            {SITE.legalEmail}
          </a>
          . Si eres asistente, también puedes pedírselo al organizador del
          evento, que es el responsable de tus datos.
        </p>
      </section>

      <section>
        <h2>8. Seguridad</h2>
        <p>
          Aplicamos medidas técnicas razonables: contraseñas con hash, cifrado
          en tránsito, control de acceso por roles y registros de auditoría de
          las acciones sensibles. Ningún sistema es infalible; si detectamos un
          incidente que te afecte, te lo comunicaremos.
        </p>
      </section>

      <section>
        <h2>9. Menores</h2>
        <p>
          El servicio no está dirigido a menores de edad sin la autorización de
          su representante legal.
        </p>
      </section>

      <section>
        <h2>10. Cambios</h2>
        <p>
          Podemos actualizar esta política. Publicaremos la versión vigente en
          esta página con su fecha de actualización.
        </p>
      </section>
    </LegalLayout>
  );
}
