/**
 * Catalogo en (ingles).
 *
 * Debe tener EXACTAMENTE las mismas claves que es.js (i18nParity.test.mjs lo
 * verifica en CI). Traduccion directa de la UI de login.
 */
export default {
  login: {
    documentTitle: "Enter your panel",
    brandTag: "Professional ticketing, capacity and door control",
    showcaseLabel: "Enty demo: event, ticket and door scan",
    title: "Enter your panel",
    subtitle: "Sign in with your email or username.",
    labelIdent: "Email or username",
    labelPassword: "Password",
    placeholderIdent: "email or @username",
    placeholderPassword: "Your password",
    showPassword: "Show password",
    hidePassword: "Hide password",
    remember: "Keep me signed in on this device",
    rememberAria: "Keep the session open on this device",
    rememberHint: "Uncheck it when using a shared device.",
    forgot: "Forgot your password?",
    forgotBusy: "Sending…",
    submit: "Sign in",
    submitBusy: "Signing in…",
    submitOk: "Done!",
    passwordHint: "The password must be at least 6 characters.",
    capsLock: "Caps Lock is on.",
    trust: "Secure connection. We will never ask for your password by chat.",
    noAccount: "Don't have an account yet?",
    createAccount: "Create organizer account",
    myTickets: "My tickets",
    contactPrompt: "Need help?",
    contactLabel: "I need help",
    contactMessage: "Hi, I need help signing in to Enty.",
    recoveryTitle: "Recover your access",
    recoveryIntro:
      "Enter your account email. If it is registered, we will send you a password reset link.",
    recoveryLabel: "Account email",
    recoveryPlaceholder: "you@email.com",
    recoverySubmit: "Send link",
    recoveryBusy: "Sending…",
    recoveryBack: "Back to sign in",
    recoveryHint: "For security, we do not confirm whether an email has an account.",
    context: {
      door: "Sign in to continue to Door",
      doorHint: "Use the account assigned to tonight. You will return to the link.",
      invitation: "Sign in to accept your invitation",
      invitationHint: "You will return to the invitation to complete access.",
    },
    errors: {
      requiredEmail: "Enter your email or username.",
      requiredPassword: "Enter your password.",
      invalidEmail: "Enter a valid email.",
      noRole: "Your user has no role assigned",
      badCredentials: "Incorrect username or password.",
      tooMany: "Too many attempts. Wait a minute and try again.",
      network: "No connection to the server. Check your internet.",
      generic: "Could not sign in. Try again.",
      forgotNeedEmail: "Enter your account email and try again.",
      forgotFallback:
        "Check your email or ask an administrator to reset your password.",
      forgotSend: "We could not send the link. Try again.",
    },
  },
};
