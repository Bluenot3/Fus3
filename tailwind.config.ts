import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        zen: {
          bg: "#060b14",
          panel: "#0d1625",
          edge: "#21324f",
          cyan: "#2bd9ff",
          teal: "#00f0c8",
          amber: "#f9c74f",
          red: "#ff4d6d"
        }
      },
      boxShadow: {
        glass: "0 0 0 1px rgba(103, 150, 255, 0.25), 0 18px 40px rgba(0, 0, 0, 0.45)"
      },
      backdropBlur: {
        xs: "2px"
      }
    }
  },
  plugins: []
};

export default config;
