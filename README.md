<div align="center">
  <img src="./assets/Slice.js-logo.png" alt="Slice.js logo" width="150" />
  <h1>Slice.js CLI</h1>
  <p>Command-line client for building web applications with the Slice.js framework</p>
  <p>
    <a href="https://slice-js-docs.vercel.app/Documentation/CLI"><strong>Explore the docs »</strong></a>
    <br />
    <a href="https://www.npmjs.com/package/slicejs-cli"><img src="https://img.shields.io/npm/v/slicejs-cli.svg?label=CLI" alt="npm version" /></a>
    <img src="https://img.shields.io/badge/Node-%E2%89%A5%2020.0.0-339933?logo=node.js" alt="node requirement" />
    <a href="#license"><img src="https://img.shields.io/badge/License-ISC-blue.svg" alt="license" /></a>
  </p>
</div>

## Sobre este repositorio

Este repositorio contiene el CLI de Slice.js (`slicejs-cli`), la herramienta de línea de comandos para desarrollar aplicaciones con el framework. Incluye servidor de desarrollo, sistema de builds, gestión de componentes y más.

## Requisitos

- Node.js >= 20
- npm o pnpm

## Desarrollo local

1. **Clonar el repositorio**
   ```bash
   git clone https://github.com/VKneider/slicejs-cli.git
   cd slicejs-cli
   ```

2. **Instalar dependencias**
   ```bash
   npm install
   ```

3. **Probar cambios localmente**
   ```bash
   node client.js --help
   ```

   Para evitar que delegue a una instalación global:
   ```bash
   SLICE_NO_LOCAL_DELEGATION=1 node client.js --help
   ```

4. **Ejecutar tests**
   ```bash
   npm test
   ```

## Instalación (para usuarios)

### Local (Recomendada)

```bash
npm install slicejs-cli --save-dev
```

### Global (No recomendada)

```bash
npm install -g slicejs-cli
```

## Comandos principales

| Comando | Descripción |
|---------|-------------|
| `slice init` | Inicializar un proyecto Slice.js |
| `slice dev` | Servidor de desarrollo con hot reload |
| `slice build` | Compilar para producción |
| `slice start` | Servir build de producción |
| `slice get <componente>` | Instalar componentes del registro oficial |
| `slice browse` | Explorar componentes disponibles |
| `slice component create` | Crear componente local |
| `slice doctor` | Diagnosticar el proyecto |
| `slice postinstall` | Configurar scripts npm (alternativa a postinstall) |

## Postinstall Scripts

Al instalar `slicejs-cli`, el script `postinstall` configura automáticamente los scripts `slice:*` en tu `package.json`:

```json
{
  "scripts": {
    "slice:dev": "slice dev",
    "slice:start": "slice start",
    "slice:create": "slice component create",
    "slice:list": "slice component list",
    "slice:delete": "slice component delete",
    "slice:init": "slice init",
    "slice:get": "slice get",
    "slice:browse": "slice browse",
    "slice:sync": "slice sync",
    "slice:version": "slice version",
    "slice:update": "slice update"
  }
}
```

Si instalaste con `--ignore-scripts`, ejecuta manualmente:

```bash
npx slicejs-cli postinstall
```

## Inicio rápido

```bash
# 1. Crear proyecto
mkdir my-project && cd my-project
npm init -y

# 2. Instalar CLI
npm install slicejs-cli --save-dev

# 3. Inicializar
npx slicejs-cli init

# 4. Desarrollo
npx slicejs-cli dev
```

## Tests

El CLI usa el test runner nativo de Node.js:

```bash
# Todos los tests
node --test

# Tests específicos
node --test tests/postinstall-command.test.js
```

## Estructura del proyecto

```
slicejs-cli/
├── client.js              # Entry point del CLI
├── commands/              # Implementación de comandos
│   ├── init/              # slice init
│   ├── build/             # slice build
│   ├── startServer/       # slice dev / slice start
│   ├── createComponent/   # slice component create
│   └── utils/             # PathHelper, VersionChecker, etc.
├── tests/                 # Tests
└── post.js                # Postinstall hook
```

## Delegación local

Cuando el comando `slice` está disponible globalmente, automáticamente delega al CLI local del proyecto (`node_modules/slicejs-cli`). Para deshabilitar:

```bash
SLICE_NO_LOCAL_DELEGATION=1 slice version
```

## Contribuir

Damos la bienvenida a contribuciones. Revisa las guías en [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) antes de enviar cambios.

## Licencia

Distribuido bajo licencia ISC. Ver `LICENSE` para más información.

## Links

- 📘 Documentación: https://slice-js-docs.vercel.app/Documentation/CLI
- 🐙 GitHub: https://github.com/VKneider/slicejs-cli
- 📦 npm: https://www.npmjs.com/package/slicejs-cli
