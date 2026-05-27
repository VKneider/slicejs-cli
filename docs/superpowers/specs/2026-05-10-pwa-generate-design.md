# Diseno de `slice generate-pwa` (V1)

## Objetivo

Agregar un comando dedicado de CLI, `slice generate-pwa`, que convierta un build de Slice en una PWA usable offline, con estrategia de cache configurable y exclusion explicita de dominios de backend para evitar cache accidental de APIs REST.

El comando debe ser postbundle, operar sobre `dist/` y mantener una experiencia simple de V1.

## Alcance V1

- Nuevo comando `slice generate-pwa`.
- Ejecutar `build` automaticamente antes del proceso PWA.
- Generar `manifest.json` en `dist/`.
- Generar `sw.js` en `dist/`.
- Registrar Service Worker en el HTML de entrada de `dist`.
- Soportar estrategias: `hybrid` (default), `offline-first`, `network-first`.
- Persistir y leer configuracion desde `src/sliceConfig.json` en:
  - `pwa.cache.excludeDomains`.
- Aplicar exclusion efectiva de `localhost` y `127.0.0.1` en desarrollo.

## Fuera de alcance V1

- Exclusion por paths o headers (`excludePaths`, `excludeHeaders`).
- UI interactiva avanzada para crear iconos PWA.
- Soporte de push notifications, background sync o runtime caching avanzado por tipo de API.
- Plugin system formal; se deja preparado para evolucion futura.

## UX del comando

### Sintaxis

```bash
slice generate-pwa
slice generate-pwa --strategy hybrid
slice generate-pwa --strategy offline-first
slice generate-pwa --strategy network-first
slice generate-pwa --name "Mi App" --short-name "MiApp"
```

### Flags V1

- `--strategy <hybrid|offline-first|network-first>` (default: `hybrid`)
- `--name <string>`
- `--short-name <string>`

### Flujo de ejecucion

1. Ejecuta build de produccion.
2. Lee y normaliza configuracion PWA en `src/sliceConfig.json`.
3. Genera manifiesto de assets para precache desde `dist/`.
4. Genera `dist/manifest.json`.
5. Genera `dist/sw.js` con la estrategia seleccionada.
6. Inyecta (o asegura) registro SW en HTML de entrada de `dist`.
7. Imprime resumen final:
   - estrategia usada,
   - cantidad de assets precacheados,
   - dominios excluidos efectivos.

## Configuracion en `sliceConfig.json`

Seccion minima V1:

```json
{
  "pwa": {
    "cache": {
      "excludeDomains": []
    }
  }
}
```

Reglas:

- Si `pwa` no existe, el comando crea la seccion sin romper configuracion previa.
- `excludeDomains` acepta hosts exactos (ej: `api.midominio.com`).
- En ejecucion de desarrollo, se agregan de forma efectiva (no necesariamente persistida) `localhost` y `127.0.0.1`.

## Arquitectura propuesta

### Integracion CLI

- Agregar comando en `client.js`:
  - `generate-pwa`
  - opcion `--strategy`
  - opciones de nombre para manifest

### Modulos nuevos

- `commands/pwa/generatePwa.js`
  - Orquestador del flujo completo.
- `commands/pwa/ConfigResolver.js`
  - Lee/crea/normaliza `pwa.cache.excludeDomains`.
- `commands/pwa/AssetManifestBuilder.js`
  - Recorre `dist/` y arma lista precache.
- `commands/pwa/ManifestGenerator.js`
  - Genera `manifest.json` con defaults y overrides por flags.
- `commands/pwa/ServiceWorkerGenerator.js`
  - Genera `sw.js` con estrategia seleccionada y exclusiones.

## Diseno de cache

### Reglas globales

- Interceptar solo requests `GET`.
- Si el host esta en `excludeDomains`, hacer `fetch` directo (sin cache).
- Versionado de cache por build id (timestamp o hash de build).
- Al activar nuevo SW, limpiar caches viejas automaticamente.

### Estrategias

- `hybrid` (default):
  - assets estaticos -> `cache-first`.
  - navegacion HTML -> `network-first` con fallback offline.
- `offline-first`:
  - navegacion + estaticos -> `cache-first`.
  - update en background cuando haya red.
- `network-first`:
  - navegacion -> `network-first`.
  - estaticos precacheados como respaldo.

## Manejo de API REST y seguridad

Para evitar cache de backend no deseado:

- Exclusion por dominio con `excludeDomains` (regla principal de V1).
- Limitar runtime cache a activos del frontend y navegacion segun estrategia.
- No cachear metodos distintos de `GET`.

Resultado: los assets del cliente se aceleran offline, pero el backend queda fuera de cache por configuracion explicita.

## Error handling

- Si build falla, abortar `generate-pwa` con mensaje claro.
- Si `dist/` no existe tras build, abortar con diagnostico.
- Si `sliceConfig.json` es invalido, mostrar error con sugerencia de reparacion.
- Si no se puede inyectar registro SW en HTML, reportar warning y ruta objetivo.

## Testing

### Unit tests

- `ConfigResolver`:
  - crea seccion `pwa.cache.excludeDomains` cuando no existe,
  - respeta config existente.
- `AssetManifestBuilder`:
  - incluye assets esperados,
  - excluye archivos no aptos.
- `ServiceWorkerGenerator`:
  - genera logica correcta por estrategia,
  - respeta `excludeDomains`.

### Integracion

- `slice generate-pwa` ejecuta build y crea `dist/manifest.json` + `dist/sw.js`.
- registro SW presente en HTML de salida.
- exclusiones de dominio aplicadas en codigo generado.

### E2E manual minima

- Build + generate-pwa.
- Abrir app, validar installability (manifest).
- Apagar red, validar navegacion offline en `hybrid`.
- Verificar que requests a dominio excluido no se sirven desde cache SW.

## Plan de evolucion (post V1)

- `excludePaths` y `excludeHeaders`.
- soporte de iconos y shortcuts PWA asistidos.
- estrategia por ruta (ej: `/api/*` network-only).
- extraer pipeline postbundle reusable para otras features.

## Criterios de aceptacion

- Existe comando `slice generate-pwa` funcional.
- Ejecuta build antes de generar artefactos PWA.
- Genera `manifest.json` y `sw.js` en `dist/`.
- Registra SW en HTML principal de salida.
- `hybrid` es default con HTML `network-first` y fallback offline.
- Lee/escribe `pwa.cache.excludeDomains` en `src/sliceConfig.json`.
- Excluye dominios configurados del cache runtime.
- Muestra resumen final legible al usuario.
