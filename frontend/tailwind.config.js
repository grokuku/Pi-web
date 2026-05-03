/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        /* All colors reference CSS custom properties.
         * Colors that need opacity modifiers (e.g. bg-hacker-accent/10)
         * use the `rgb(var(--xxx-rgb) / <alpha-value>)` pattern.
         * This allows both dark/light theme AND accent colors to change
         * without touching any Tailwind classes. */
        hacker: {
          bg: "rgb(var(--bg-rgb) / <alpha-value>)",
          surface: "rgb(var(--surface-rgb) / <alpha-value>)",
          "surface-raised": "rgb(var(--surface-raised-rgb) / <alpha-value>)",
          border: "rgb(var(--border-rgb) / <alpha-value>)",
          "border-bright": "rgb(var(--border-bright-rgb) / <alpha-value>)",
          accent: "rgb(var(--accent-rgb) / <alpha-value>)",
          "accent-dim": "rgb(var(--accent-dim-rgb) / <alpha-value>)",
          text: "rgb(var(--text-rgb) / <alpha-value>)",
          "text-bright": "rgb(var(--text-bright-rgb) / <alpha-value>)",
          "text-dim": "rgb(var(--text-dim-rgb) / <alpha-value>)",
          warn: "rgb(var(--warn-rgb) / <alpha-value>)",
          error: "rgb(var(--error-rgb) / <alpha-value>)",
          info: "rgb(var(--info-rgb) / <alpha-value>)",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', "monospace"],
        sans: ['"JetBrains Mono"', "monospace"],
      },
      animation: {
        blink: "blink 1s step-end infinite",
        "pulse-green": "pulseGreen 2s ease-in-out infinite",
        "scan-line": "scanLine 8s linear infinite",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        pulseGreen: {
          "0%, 100%": { boxShadow: "0 0 5px var(--accent)" },
          "50%": { boxShadow: "0 0 20px var(--accent), 0 0 40px rgba(var(--accent-rgb), 0.25)" },
        },
        scanLine: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
      },
    },
  },
  plugins: [],
};