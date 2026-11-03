/**
 * ENTY — Sistema de Tokens de Marca Premium
 * 
 * SOLE PURPOSE: Single source of truth for all visual values.
 * 
 * THIS FILE EXISTS FOR:
 * - Documentation of the design system
 * - Future refactoring when build compatibility improves
 * - Consistency across the team
 * 
 * DO NOT import these values directly into JSX style={} objects during build.
 * Use the literal values from this file hardcoded in component styles.
 * 
 * LAYOUT:
 * c = colors, s = spacing, t = typography, z = zIndex, m = motion, br = breakpoints, con = constants
 * 
 * All values below are the authoritative versions. Components should use the
 * literal hex/rem strings from this file, not dynamic imports.
 */

// Colores principales de la marca ENTY
export const c = {
  // Negro profundo - fondo principal
  background: '#0B0B0F',
  // Negro carbón - superficie de cards/panels
  surface: '#18181B',
  // Gris muy claro - superficie alternativa
  surfaceLight: '#202025',
  // Lila muy claro - para fondos ligrados con primary
  surfaceTint: '#F3F1EC',
  
  // Violeta principal - marca ENTY
  primary: '#7C3AED',
  // Violeta hover - un tono más oscuro
  primaryHover: '#6D28D9',
  // Violeta active - presionado
  primaryActive: '#5E2DAD',
  // Lila claro - para gradientes con primary
  primaryLight: '#F3E8FF',
  // Violeta oscuro - para profundidad
  primaryDark: '#6B46C1',
  // Blanco sobre primary
  primaryContrast: '#FFFFFF',
  
  // Rosa secundario - acentos
  secondary: '#EC4899',
  secondaryHover: '#DB2777',
  secondaryActive: '#BE185D',
  
  // Escala de grises zinc
  zinc900: '#0F0F13',
  zinc800: '#18181B',
  zinc700: '#27272A',
  zinc600: '#3F3F46',
  zinc500: '#71717A',
  zinc400: '#A3A3AA',
  zinc300: '#E5E5E6',
  zinc200: '#F4F4F5',
  zinc100: '#F9FAFB',
  
  // Texto
  textPrimary: '#F5F5F7',
  textSecondary: '#71717A',
  textMuted: '#A3A3AA',
  textInverted: '#0B0B0F',
  
  // Estados semánticos
  success: '#10B981',
  successSoft: '#D1F0E8',
  error: '#EF4444',
  errorSoft: '#FEE2E2',
  warning: '#F59E0B',
  warningSoft: '#FFFBEB',
  info: '#3B82F6',
  
  // Gradientes de marca
  gradientPrimary: 'linear-gradient(135deg, #7C3AED 0%, #6D28D9 100%)',
  gradientSecondary: 'linear-gradient(135deg, #F3E8FF 0%, #E4D8F5 100%)',
  gradientDark: 'linear-gradient(180deg, #0B0B0F 0%, #18181B 100%)',
  gradientCard: 'linear-gradient(180deg, #18181B 0%, #27272A 100%)',
  
  // Bordes
  border: '#3F3F46',
  borderLight: '#6B7280',
  borderFocus: '#7C3AED',
  
  // Sombras
  shadowSm: '0 1px 2px rgba(0, 0, 0, 0.05)',
  shadowMd: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
  shadowLg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  shadowxl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  shadowInner: 'inset 0 2px 4px rgba(0, 0, 0, 0.15)',
  
  // Border radius
  radiusSm: '0.125rem',
  radiusMd: '0.375rem',
  radiusLg: '0.5rem',
  radiusFull: '9999px',
  
  // Opacidades
  opacityNone: '0',
  opacityXs: '0.05',
  opacitySm: '0.1',
  opacityMd: '0.15',
  opacityBg: '0.5',
  opacityLg: '0.7',
};

// Espaciado en rem
export const s = {
  xs: '0.25rem', // 4px
  sm: '0.5rem',  // 8px
  md: '1rem',    // 16px
  lg: '1.5rem',  // 24px
  xl: '2rem',    // 32px
  xxl: '3rem',   // 48px
  xxxl: '4rem',  // 64px
};

// Tipografía
export const t = {
  fontFamily:
    '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: {
    xs: '0.75rem',   // 12px
    sm: '0.875rem',  // 14px
    md: '1rem',      // 16px
    lg: '1.125rem',  // 18px
    xl: '1.25rem',   // 20px
    '2xl': '1.5rem', // 24px
    '3xl': '1.875rem', // 30px
    '4xl': '2.25rem', // 36px
    '5xl': '3rem',   // 48px
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    none: '1',
    tight: '1.25',
    normal: '1.5',
    relaxed: '1.625',
    spacious: '1.75',
  },
  letterSpacing: {
    tighter: '-0.05em',
    tight: '-0.025em',
    normal: '0em',
    wide: '0.025em',
    wider: '0.05em',
    widest: '0.1em',
  },
};

// Z-index
export const z = {
  base: 0,
  dropdown: 1000,
  sticky: 1020,
  modal: 1030,
  popup: 1050,
  tooltip: 1100,
};

// Motion / animaciones con curvas naturales
export const m = {
  easeIn: 'cubic-bezier(0.4, 0, 0.2, 1)',
  easeOut: 'cubic-bezier(0.0, 0, 0.2, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  easeInSine: 'cubic-bezier(0.47, 0, 0.74, 0.71)',
  easeOutSine: 'cubic-bezier(0.39, 0.57, 0.56, 1)',
  easeInOutSine: 'cubic-bezier(0.44, 0.09, 0.36, 0.56)',
  fast: '150ms',
  normal: '250ms',
  slow: '350ms',
  transitionAlpha: 'opacity 250ms cubic-bezier(0.4, 0, 0.2, 1)',
  transitionScale: 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)',
  transitionColor:
    'color 200ms cubic-bezier(0.4, 0, 0.2, 1), background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
  transitionShadow: 'box-shadow 250ms cubic-bezier(0.4, 0, 0.2, 1)',
};

// Puntos de quiebre responsive
export const br = {
  sm: '640px',   // Teléfonos pequeños
  md: '768px',   // Tablets pequeñas
  lg: '1024px',  // Tablets
  xl: '1280px',  // Laptops
  '2xl': '1536px', // Desktops grandes
};

// Constantes de negocio/design
export const con = {
  soldAlertPct: 70,      // % de aforo para alerta "casi agotado"
  loadingSpinner: '0.5rem', // Tamaño spinner loading
  avatarSize: '4rem',    // Tamaño avatar padrão
  skipLinkOffset: '4rem',  // Offset para skip links accessibility
};