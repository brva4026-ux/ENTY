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
    documentTitle: "Entrar a tu panel",
    brandTag: "Boletería profesional, aforo y control de puerta",
    showcaseLabel: "Demostración de Enty: evento, boleta y escaneo en puerta",
    roles: {
      admin: {
        label: "Administración",
        welcome: "Bienvenido a Administración",
      },
      promotor: {
        label: "Promotores",
        welcome: "Tu espacio de promotor",
      },
      bouncer: {
        label: "Puerta",
        welcome: "Tu acceso de Puerta",
      },
    },
    welcome: {
      kicker: "¡Bienvenido!",
      confirming: "Confirmando permisos…",
      choose: "Elige cómo entrar",
      confirmed: "Permisos confirmados. Ingresando...",
      rolesLabel: "Tus accesos",
      chooseRoleAria: "Elige tu rol",
      changeUsername: "Cambiar usuario",
      continue: "Entrar a {role}",
      preparing: "Preparando tu panel",
      doorNote:
        "Entrarás al escáner de la noche asignada. Si no aparece, pide al admin que te asigne.",
    },
    title: "Entra a tu panel",
    subtitle: "Accede con tu correo o nombre de usuario.",
    labelIdent: "Correo o nombre de usuario",
    labelPassword: "Contraseña",
    placeholderIdent: "correo o @usuario",
    placeholderPassword: "Tu contraseña",
    showPassword: "Mostrar contraseña",
    hidePassword: "Ocultar contraseña",
    remember: "Mantener sesión en este dispositivo",
    rememberAria: "Mantener la sesión abierta en este dispositivo",
    rememberHint: "Desmárcala si entras desde un equipo compartido.",
    forgot: "¿Olvidaste tu contraseña?",
    forgotBusy: "Enviando…",
    submit: "Entrar",
    submitBusy: "Entrando…",
    submitOk: "¡Listo!",
    passwordHint: "La contraseña debe tener al menos 6 caracteres.",
    capsLock: "Bloq Mayús está activado.",
    trust: "Conexión segura. Nunca te pediremos tu contraseña por chat.",
    noAccount: "¿Aún no tienes cuenta?",
    createAccount: "Crear cuenta de organizador",
    myTickets: "Mis boletas",
    contactPrompt: "¿Necesitas ayuda?",
    contactLabel: "Necesito ayuda",
    contactMessage: "Hola, necesito ayuda para entrar a Enty.",
    recoveryTitle: "Recupera tu acceso",
    recoveryIntro:
      "Escribe el correo de tu cuenta. Si está registrado, te enviaremos un enlace para restablecer la contraseña.",
    recoveryLabel: "Correo de la cuenta",
    recoveryPlaceholder: "tu@correo.com",
    recoverySubmit: "Enviar enlace",
    recoveryBusy: "Enviando…",
    recoveryBack: "Volver a iniciar sesión",
    recoveryHint: "Por seguridad, no confirmamos si un correo tiene cuenta.",
    context: {
      door: "Entra para continuar a Puerta",
      doorHint: "Usa la cuenta asignada a esta noche. Al entrar volverás al enlace.",
      invitation: "Entra para aceptar tu invitación",
      invitationHint:
        "Al entrar volverás a la invitación para completar tu acceso.",
    },
    errors: {
      requiredEmail: "Escribe tu correo o nombre de usuario.",
      requiredPassword: "Escribe tu contraseña.",
      invalidEmail: "Escribe un correo válido.",
      noRole: "Tu usuario no tiene un rol asignado",
      badCredentials: "Usuario o contraseña incorrectos.",
      tooMany: "Demasiados intentos. Espera un minuto e intenta de nuevo.",
      network: "No hay conexión con el servidor. Revisa tu internet.",
      generic: "No se pudo iniciar sesión. Intenta de nuevo.",
      forgotNeedEmail: "Escribe el correo de tu cuenta y vuelve a intentarlo.",
      forgotFallback:
        "Revisa tu correo o pídele a un administrador que restablezca tu contraseña.",
      forgotSend: "No pudimos enviar el enlace. Intenta de nuevo.",
    },
  },
};
