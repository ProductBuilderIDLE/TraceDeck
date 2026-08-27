// Colours resolve to CSS custom properties so a theme can be swapped at runtime.
// The `<alpha-value>` placeholder is what keeps opacity modifiers such as `bg-brand/15`
// working against a variable; it requires the variable to hold space-separated RGB channels.
const withAlpha = (token) => `rgb(var(--${token}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: withAlpha('surface-0'),
          1: withAlpha('surface-1'),
          2: withAlpha('surface-2'),
          3: withAlpha('surface-3'),
          4: withAlpha('surface-4'),
        },
        edge: withAlpha('edge'),
        ink: {
          DEFAULT: withAlpha('ink'),
          muted: withAlpha('ink-muted'),
          faint: withAlpha('ink-faint'),
        },
        brand: {
          DEFAULT: withAlpha('brand'),
          dim: withAlpha('brand-dim'),
        },
        risk: {
          low: withAlpha('risk-low'),
          med: withAlpha('risk-med'),
          high: withAlpha('risk-high'),
          crit: withAlpha('risk-crit'),
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
