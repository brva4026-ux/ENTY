/**
 * Catalogo es (idioma por defecto).
 *
 * Reglas del proyecto:
 *  - Este archivo es la FUENTE de las claves. `en.js` debe tener exactamente
 *    las mismas (el test i18nParity.test.mjs lo verifica).
 *  - El texto español de aqui debe coincidir, palabra por palabra, con lo que
 *    la app mostraba antes de traducir: es la UI real, no una copia.
 *  - Una clave sin traducir NO rompe el render: `translate` devuelve la clave.
 */
export default {
  login: {
    documentTitle: "Iniciar sesión",
    brandTag: "Boletería, aforo y control de puerta",
    title: "Iniciar sesión",
    subtitle: "Entra con tu usuario o correo para continuar.",
    labelIdent: "Usuario o correo",
    labelPassword: "Contraseña",
    placeholderIdent: "usuario o tu@",
    placeholderPassword: "Tu contraseña",
    showPassword: "Mostrar contraseña",
    hidePassword: "Ocultar contraseña",
    remember: "Recordarme",
    rememberAria: "Recordarme para la próxima visita",
    forgot: "¿Olvidaste tu contraseña?",
    forgotBusy: "Enviando…",
    submit: "Entrar",
    submitBusy: "Entrando…",
    submitOk: "¡Listo!",
    emailHint: "Si usas correo, revisa que incluya @ y el dominio.",
    passwordHint: "La contraseña debe tener al menos 6 caracteres.",
    capsLock: "Bloq Mayús está activado.",
    trust: "Conexión segura. Nunca te pediremos tu contraseña por chat.",
    noAccount: "¿Aún no tienes cuenta?",
    createAccount: "Crear cuenta",
    contactPrompt: "¿Problemas para entrar?",
    contactLabel: "Contáctanos",
    contactMessage: "Hola, necesito ayuda para entrar a Enty.",
    errors: {
      requiredEmail: "Escribe tu correo.",
      requiredPassword: "Escribe tu contraseña.",
      noRole: "Tu usuario no tiene un rol asignado",
      badCredentials: "Usuario o contraseña incorrectos.",
      tooMany: "Demasiados intentos. Espera un minuto e intenta de nuevo.",
      network: "No hay conexión con el servidor. Revisa tu internet.",
      generic: "No se pudo iniciar sesión. Intenta de nuevo.",
      forgotNeedEmail: "Escribe tu correo arriba y vuelve a intentarlo.",
      forgotFallback:
        "Revisa tu correo o pídele a un administrador que restablezca tu contraseña.",
      forgotSend: "No pudimos enviar el enlace. Intenta de nuevo.",
    },
  },
};
