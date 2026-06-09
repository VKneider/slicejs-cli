import chokidar from 'chokidar';
import chalk from 'chalk';
import Print from '../Print.js';

/**
 * Configures the watcher for project files
 * @param {ChildProcess} serverProcess - Server process
 * @returns {FSWatcher} - Chokidar watcher
 */
export default function setupWatcher(serverProcess, onRestart) {
    Print.info('Watch mode enabled - monitoring file changes...');
    Print.newLine();

    const watcher = chokidar.watch(['api/**/*'], {
        ignored: [
            /(^|[\/\\])\../,  // hidden files
            '**/node_modules/**',
            '**/dist/**',
            '**/bundles/**',
            '**/*.log'
        ],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 50
        }
    });

    let reloadTimeout;

    const handleChange = (changedPath) => {
        clearTimeout(reloadTimeout);
        reloadTimeout = setTimeout(() => {
            if (onRestart) {
                console.log(chalk.yellow('🔄 API change detected, restarting server...'));
                onRestart(changedPath);
            }
        }, 500);
    };

    watcher
        .on('change', handleChange)
        .on('add', handleChange)
        .on('unlink', handleChange)
        .on('error', (error) => {
            Print.error(`Watcher error: ${error.message}`);
        })
        .on('ready', () => {
            console.log(chalk.gray('👀 Watching for file changes...'));
            Print.newLine();
        });

    return watcher;
}

/**
 * Stops the watcher safely
 * @param {FSWatcher} watcher - Watcher to stop
 */
export function stopWatcher(watcher) {
    if (watcher) {
        watcher.close();
        console.log(chalk.gray('Watch mode stopped'));
    }
}
