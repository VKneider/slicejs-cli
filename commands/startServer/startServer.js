// commands/startServer/startServer.js - MEJORADO CON VALIDACIÓN Y FEEDBACK

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createServer } from 'net';
import setupWatcher, { stopWatcher } from './watchServer.js';
import Print from '../Print.js';
import { getConfigPath, getApiPath, getSrcPath, getDistPath } from '../utils/PathHelper.js';
import build from '../build/build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Carga la configuración desde sliceConfig.json
 */
const loadConfig = () => {
  try {
    const configPath = getConfigPath(import.meta.url);
    const rawData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(rawData);
  } catch (error) {
    Print.error(`Loading configuration: ${error.message}`);
    return null;
  }
};

/**
 * Verifica si un puerto está disponible
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Verifica si existe un build de producción
 */
async function checkProductionBuild() {
  const distDir = getDistPath(import.meta.url);
  const bundleConfigPath = path.join(distDir, 'bundles', 'bundle.config.json');
  return (await fs.pathExists(distDir)) && (await fs.pathExists(bundleConfigPath));
}

/**
 * Verifica si existe la estructura de desarrollo
 */
async function checkDevelopmentStructure() {
  const srcDir = getSrcPath(import.meta.url);
  const apiDir = getApiPath(import.meta.url);

  return (await fs.pathExists(srcDir)) && (await fs.pathExists(apiDir));
}

/**
 * Inicia el servidor Node.js con argumentos y mejor feedback
 */
function startNodeServer(port, mode) {
  return new Promise((resolve, reject) => {
    const apiIndexPath = getApiPath(import.meta.url, 'index.js');

    // Verificar que el archivo existe
    if (!fs.existsSync(apiIndexPath)) {
      reject(new Error(`Server file not found: ${apiIndexPath}`));
      return;
    }

    Print.serverStatus('starting', 'Starting server...');

    // Construir argumentos basados en el modo
    const args = [apiIndexPath];
    if (mode === 'production') {
      args.push('--production');
    } else if (mode === 'bundled') {
      args.push('--bundled');
    } else {
      args.push('--development');
    }

    // Ensure the spawned server process receives NODE_ENV consistent with the
    // requested mode. This guarantees code that only checks process.env.NODE_ENV
    // (instead of CLI flags) will behave as expected.
    const serverEnv = {
      ...process.env,
      PORT: port,
      NODE_ENV: mode === 'production' ? 'production' : (process.env.NODE_ENV || 'development')
    };

    const serverProcess = spawn('node', args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: serverEnv
    });

    let serverStarted = false;
    let outputBuffer = '';

    // Capturar la salida para detectar cuando el servidor está listo
    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      outputBuffer += output;

      // Detectar mensajes comunes que indican que el servidor ha iniciado
      if (!serverStarted && (
        output.includes('Server running') ||
        output.includes('listening on') ||
        output.includes('Started on') ||
        output.includes(`port ${port}`)
      )) {
        serverStarted = true;
        Print.serverReady(port);
      }

      // Mostrar la salida del servidor
      process.stdout.write(output);
    });

    serverProcess.stderr.on('data', (data) => {
      const output = data.toString();
      process.stderr.write(output);
    });

    serverProcess.on('error', (error) => {
      if (!serverStarted) {
        Print.serverStatus('error', `Failed to start server: ${error.message}`);
        reject(error);
      }
    });

    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0 && !serverStarted) {
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    // Manejar Ctrl+C
    process.on('SIGINT', () => {
      Print.newLine();
      Print.info('Shutting down server...');
      serverProcess.kill('SIGINT');
      setTimeout(() => {
        process.exit(0);
      }, 100);
    });

    process.on('SIGTERM', () => {
      serverProcess.kill('SIGTERM');
    });

    // Si después de 3 segundos no detectamos inicio, asumimos que está listo
    setTimeout(() => {
      if (!serverStarted) {
        serverStarted = true;
        Print.serverReady(port);
      }
      resolve(serverProcess);
    }, 3000);
  });
}

/**
 * Función principal para iniciar servidor
 */
export default async function startServer(options = {}) {
  const config = loadConfig();
  const defaultPort = config?.server?.port || 3000;

  const { mode = 'development', port = defaultPort, watch = false } = options;

  try {
    Print.title(`🚀 Starting Slice.js ${mode} server...`);
    Print.newLine();

    // Verificar estructura del proyecto
    if (!await checkDevelopmentStructure()) {
      throw new Error('Project structure not found. Run "slice init" first.');
    }

    let actualPort = await isPortAvailable(port) ? port : port + 1; // Try one more port
    if(actualPort !== port) {
       // Check if the fallback is available
       const fallbackAvailable = await isPortAvailable(actualPort);
       if(!fallbackAvailable) {
           throw new Error(`Ports ${port} and ${actualPort} are in use.`);
       }
       Print.info(`ℹ️ Port ${port} in use, using ${actualPort} instead.`);
    }

    Print.serverStatus('checking', `Port ${actualPort} available ✓`);
    Print.newLine();

    if (mode === 'production') {
      // Verificar que existe build de producción
      if (!await checkProductionBuild()) {
        Print.info('No production build found. Running "slice build"...');
        const success = await build({});
        if (!success) {
          throw new Error('Build failed. Cannot start production server.');
        }
      }
      Print.info('Production mode: serving optimized files from /dist');
    } else {
      Print.info('Development mode: serving files from /src with hot reload');
    }

    Print.newLine();

    // Iniciar el servidor con argumentos
    let serverProcess = await startNodeServer(actualPort, mode);

    // Configurar watch mode si está habilitado
    if (watch) {
      Print.newLine();
      const watcher = setupWatcher(serverProcess, async (changedPath) => {
        if (serverProcess) {
             serverProcess.kill();
        }
        
        // Short delay to ensure port is freed
        await new Promise(r => setTimeout(r, 500));
        
        try {
        Print.info('🔄 File changed. Restarting server...');

          serverProcess = await startNodeServer(actualPort, mode);
        } catch (e) {
          Print.error(`Failed to restart server: ${e.message}`);
        }
      });

      // Cleanup en exit
      const cleanup = () => {
        stopWatcher(watcher);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    }

  } catch (error) {
    Print.newLine();
    Print.error(error.message);
    throw error;
  }
}

/**
 * Funciones de utilidad exportadas
 */
export { checkProductionBuild, checkDevelopmentStructure, isPortAvailable };
