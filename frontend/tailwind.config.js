/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#6366f1',
        secondary: '#8b5cf6',
        'codec-green': '#00ff88',
        'codec-green-dim': '#00aa5e',
        'codec-green-dark': '#004422',
        'codec-blue': '#00aaff',
        'codec-blue-dim': '#0077aa',
        'codec-bg': '#0a0f0a',
      },
      fontFamily: {
        mono: ['Share Tech Mono', 'Courier New', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'scanline': 'scanline 8s linear infinite',
      },
      keyframes: {
        scanline: {
          '0%': { top: '-4px' },
          '100%': { top: '100%' },
        },
      },
    },
  },
  plugins: [],
};
