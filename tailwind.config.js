/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './public/index.html',
    './public/js/**/*.js',
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
