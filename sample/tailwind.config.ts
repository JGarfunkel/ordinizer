import type { Config } from "tailwindcss";
import path from "path";
import { fileURLToPath } from "url";

const baseDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  darkMode: ["class"],
  content: [
    path.resolve(baseDir, "index.html"),
    path.resolve(baseDir, "src/**/*.{js,jsx,ts,tsx}"),
    // Local dev: sibling ordinizer repo
    path.resolve(baseDir, "../../ordinizer/app/client/src/**/*.{js,jsx,ts,tsx}"),
    path.resolve(baseDir, "../../ordinizer/client/src/**/*.{js,jsx,ts,tsx}"),
    // Production: ordinizer installed as npm package
    path.resolve(baseDir, "../node_modules/@civillyengaged/ordinizer-client/**/*.{js,ts,jsx,tsx}"),
  ],
  safelist: [
    {
      pattern: /(bg|text|border|fill|stroke)-(primary|secondary|muted|accent|green|red|blue|purple|gray)-(50|100|200|300|400|500|600|700|800|900)/,
    },
    {
      pattern: /(grid-cols|col-span|row-span)-(\d+)/,
    },
  ],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        chart: {
          "1": "var(--chart-1)",
          "2": "var(--chart-2)",
          "3": "var(--chart-3)",
          "4": "var(--chart-4)",
          "5": "var(--chart-5)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar-background)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
        // Ordinizer custom colors
        'civic-blue': 'var(--civic-blue)',
        'civic-blue-dark': 'var(--civic-blue-dark)',
        'civic-gray': 'var(--civic-gray)',
        'civic-gray-light': 'var(--civic-gray-light)',
        'civic-success': 'var(--civic-success)',
        'civic-warning': 'var(--civic-warning)',
        'civic-error': 'var(--civic-error)',
        'civic-bg': 'var(--civic-bg)',
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config;
