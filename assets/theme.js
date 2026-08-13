/* Solaris palette for the Tailwind CDN build. Must run after the CDN script. */
tailwind.config = {
theme: {
  extend: {
    fontFamily: { sans: ['Poppins', 'sans-serif'] },
    colors: {
      primary: { DEFAULT: '#FF8500', 50: '#FFF6EC', 100: '#FFE8CC', 200: '#FFD199', 600: '#E67700' },
      secondary: { DEFAULT: '#0072FF', 50: '#EFF6FF' },
      ok: '#22C55E', warn: '#F59E0B', danger: '#EF4444', info: '#0EA5E9',
      ink: '#191919', muted: '#6B7280', faint: '#9CA3AF',
      line: '#E6EBF1', shell: '#F6F6FB',
    },
    boxShadow: {
      card: '0 1px 2px rgba(25,25,25,.04), 0 4px 16px rgba(25,25,25,.05)',
      pop: '0 20px 60px rgba(25,25,25,.18)',
    },
  }
}
}
