/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}",
  ],
  theme: {
    extend: {
      colors: {
        'arte-pessego': '#F3D1C1',
        'arte-rosa': '#E9B3A2',
        'arte-creme': '#FFF9F6',
        'arte-texto': '#4A3F35',
      },
    },
  },
  plugins: [],
}
