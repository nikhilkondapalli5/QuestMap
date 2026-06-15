import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react') || id.includes('react-router-dom')) return 'react';
          if (id.includes('framer-motion')) return 'motion';
          if (id.includes('@firebase') || id.includes('/firebase/')) return 'firebase';
          if (id.includes('/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
})
