/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'sans-serif'],
        body: ['"Manrope"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      },
      colors: {
        // Dark slate cockpit — readable, not void
        ink: {
          950: '#0b0c11',
          900: '#0f1117',
          800: '#14161e',
          700: '#1a1d27',
          600: '#222633',
          500: '#2c3040'
        },
        accent: {
          400: '#fcd980',
          500: '#f0b429',
          600: '#d99e1e',
          700: '#b8861a'
        },
        border: {
          subtle: '#232838',
          medium: '#2e3446'
        },
        surface: {
          1: '#131520',
          2: '#181b26',
          3: '#1e2230'
        },
        // Warm text scale
        txt: {
          1: '#f0ede8',
          2: '#b5b1ab',
          3: '#7d7a75',
          4: '#565450'
        }
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' }
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        pulse_glow: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.7' }
        }
      },
      animation: {
        'fade-up': 'fade-up 0.45s ease-out forwards',
        'slide-in-right': 'slide-in-right 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.3s ease-out',
        'pulse-glow': 'pulse_glow 3s ease-in-out infinite'
      }
    }
  },

  plugins: []
}
