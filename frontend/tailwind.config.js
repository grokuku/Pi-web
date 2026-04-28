/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        hacker: {
          bg: "#0a0a0a",
          surface: "#161616",
          "surface-raised": "#1e1e1e",
          border: "#2a2a2a",
          "border-bright": "#3a3a3a",
          accent: "#00ff41",
          "accent-dim": "#00cc34",
          text: "#c0c0c0",
          "text-bright": "#e0e0e0",
          "text-dim": "#888888",
          warn: "#ffaa00",
          error: "#ff4444",
          info: "#00aaff",
        },
        hackerLight: {
          bg: "#f5f5f0",
          surface: "#ffffff",
          "surface-raised": "#fafafa",
          border: "#d0d0d0",
          "border-bright": "#bbbbbb",
          accent: "#008022",
          "accent-dim": "#00661a",
          text: "#333333",
          "text-bright": "#111111",
          "text-dim": "#888888",
          warn: "#cc8800",
          error: "#cc0000",
          info: "#0066cc",
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
          "0%, 100%": { boxShadow: "0 0 5px #00ff41" },
          "50%": { boxShadow: "0 0 20px #00ff41, 0 0 40px #00ff4140" },
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
