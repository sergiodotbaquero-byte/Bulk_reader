import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { version } from './package.json';

// HTTPS en `vite dev` (y en `npm run preview:https`): la cámara exige un contexto seguro,
// y así se puede probar desde el celular entrando por la IP del PC (aceptando el certificado
// autofirmado). `npm run preview` normal queda en http para abrirlo en el PC sin avisos.
export default defineConfig(({ command, isPreview, mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    ...(command === 'serve' && (!isPreview || mode === 'https') ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        id: '/',
        name: 'MTG Bulk Scanner',
        short_name: 'MTG Scanner',
        description: 'Escanea cartas de Magic: The Gathering con la cámara y arma tu inventario de bulk.',
        lang: 'es',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        categories: ['utilities', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // El motor OCR pesa varios MB y tiene variantes (simd / sin simd): se cachea al usarse, no al instalar.
        globIgnores: ['tesseract/**', 'names/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/tesseract\//, /^\/names\//],
        runtimeCaching: [
          {
            // worker, núcleo WASM y datos del idioma (servidos desde la propia app)
            urlPattern: /\/tesseract\/.*\.(?:js|wasm|gz)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-engine',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // nombres impresos en otros idiomas (≈1 MB por idioma; la app los guarda en IndexedDB)
            urlPattern: /\/names\/[a-z]+\.json$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'card-names',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/cards\.scryfall\.io\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-images',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/api\.scryfall\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'scryfall-api',
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 1000, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
}));
