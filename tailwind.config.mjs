/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#e3f5e9',
          500: '#3e6f65',
          700: '#0a5c2e',
        },
      },
    },
  },
  plugins: [],
};
