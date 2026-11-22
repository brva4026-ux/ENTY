/**
 * Catalogo en (ingles).
 *
 * Debe tener EXACTAMENTE las mismas claves que es.js (i18nParity.test.mjs lo
 * verifica en CI). Traduccion directa de la UI de login.
 */
export default {
  login: {
    documentTitle: "Sign in",
    brandTag: "Ticketing, capacity and door control",
    title: "Sign in",
    subtitle: "Enter with your email or username to continue.",
    labelIdent: "Email or username",
    labelPassword: "Password",
    placeholderIdent: "email or @username",
    placeholderPassword: "Your password",
    showPassword: "Show password",
    hidePassword: "Hide password",
    remember: "Remember me",
    rememberAria: "Remember me for next visit",
    forgot: "Forgot your password?",
    forgotBusy: "Sending…",
    submit: "Sign in",
    submitBusy: "Signing in…",
    submitOk: "Done!",
    passwordHint: "The password must be at least 6 characters.",
    capsLock: "Caps Lock is on.",
    trust: "Secure connection. We will never ask for your password by chat.",
    noAccount: "Don't have an account yet?",
    createAccount: "Create account",
    contactPrompt: "Trouble signing in?",
    contactLabel: "Contact us",
    contactMessage: "Hi, I need help signing in to Enty.",
    errors: {
      requiredEmail: "Enter your email or username.",
      requiredPassword: "Enter your password.",
      noRole: "Your user has no role assigned",
      badCredentials: "Incorrect username or password.",
      tooMany: "Too many attempts. Wait a minute and try again.",
      network: "No connection to the server. Check your internet.",
      generic: "Could not sign in. Try again.",
      forgotNeedEmail: "Enter your email above and try again.",
      forgotFallback:
        "Check your email or ask an administrator to reset your password.",
      forgotSend: "We could not send the link. Try again.",
    },
  },
};
