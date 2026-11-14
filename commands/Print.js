import chalk from 'chalk';

/**
 * CLI output vocabulary.
 *
 * One symbol per severity, one alignment for hints, no repeated "Info:" /
 * "Success:" labels. Commands should print outcomes, not log levels.
 */
export default class Print {
   constructor() { }

   static error(message) {
      console.error(`${chalk.red('✖')} ${message}`);
   }

   static success(message) {
      console.log(`${chalk.green('✔')} ${message}`);
   }

   static warning(message) {
      console.log(`${chalk.yellow('!')} ${message}`);
   }

   static info(message) {
      console.log(`${chalk.cyan('•')} ${message}`);
   }

   static title(message) {
      console.log(`\n${chalk.bold(message)}`);
   }

   static subtitle(message) {
      console.log(chalk.cyan.bold(message));
   }

   static step(stepNumber, message) {
      console.log(`${chalk.cyan(`${stepNumber}.`)} ${message}`);
   }

   static highlight(message) {
      console.log(chalk.bgYellow.black(` ${message} `));
   }

   static newLine() {
      console.log('');
   }

   static separator() {
      console.log(chalk.gray('─'.repeat(52)));
   }

   static componentSuccess(componentName, action = 'processed') {
      console.log(`${chalk.green('✔')} ${chalk.bold(componentName)} ${action}`);
   }

   static componentError(componentName, action = 'processing', error) {
      console.error(`${chalk.red('✖')} ${action} ${chalk.bold(componentName)}: ${error}`);
   }

   static downloadProgress(fileName) {
      console.log(`${chalk.gray('  ↓')} ${fileName}`);
   }

   static downloadError(fileName) {
      console.error(`${chalk.red('  ✖')} ${fileName}`);
   }

   static registryUpdate(message) {
      console.log(`${chalk.magenta('  +')} ${message}`);
   }

   static versionInfo(component, currentVersion, latestVersion = null) {
      if (latestVersion && currentVersion !== latestVersion) {
         console.log(`${chalk.yellow('↑')} ${component}: v${currentVersion} → v${latestVersion}`);
      } else {
         console.log(`${chalk.green('✔')} ${component}: v${currentVersion}`);
      }
   }

   static commandExample(description, command) {
      console.log(chalk.gray(`  ${description}`));
      console.log(chalk.cyan(`  → ${command}`));
   }

   static summary(successful, failed, total) {
      Print.separator();
      console.log(chalk.bold('Summary'));
      if (successful > 0) Print.success(`Successful: ${successful}/${total}`);
      if (failed > 0) Print.error(`Failed: ${failed}/${total}`);
      Print.separator();
   }

   static minificationResult(filename, originalSize, minifiedSize, savingsPercent) {
      const originalKB = (originalSize / 1024).toFixed(1);
      const minifiedKB = (minifiedSize / 1024).toFixed(1);
      console.log(`${chalk.green('  ✔')} ${filename}`);
      console.log(chalk.gray(`     ${originalKB} KB → ${minifiedKB} KB (${savingsPercent}% saved)`));
   }

   static buildProgress(message) {
      console.log(`${chalk.cyan('→')} ${message}`);
   }

   static serverStats(mode, port, directory) {
      Print.newLine();
      console.log(chalk.bold('Server'));
      console.log(`${chalk.gray('  Mode     ')} ${mode}`);
      console.log(`${chalk.gray('  Port     ')} ${port}`);
      console.log(`${chalk.gray('  Serving  ')} /${directory}`);
      Print.newLine();
   }

   static serverReady(port) {
      Print.newLine();
      console.log(chalk.bgGreen.black.bold(' READY '));
      Print.newLine();
      console.log(`${chalk.bold('  Local    ')} ${chalk.cyan(`http://localhost:${port}`)}`);
      console.log(`${chalk.gray('  Loopback ')} http://127.0.0.1:${port}`);
      Print.newLine();
      console.log(chalk.gray('  Press Ctrl+C to stop'));
      Print.newLine();
   }

   static serverStatus(status, message = '') {
      const icons = {
         checking: '…',
         starting: '→',
         ready: '✔',
         error: '✖'
      };
      const colors = {
         checking: chalk.gray,
         starting: chalk.cyan,
         ready: chalk.green,
         error: chalk.red
      };
      const icon = icons[status] || '•';
      const color = colors[status] || chalk.white;
      console.log(color(`${icon} ${message || status}`));
   }

   static checkingPort(port) {
      console.log(chalk.gray(`… Checking port ${port}`));
   }

   static debug(message) {
      console.log(chalk.gray(`  debug  ${message}`));
   }

   static stack(error) {
      if (!process.env.SLICE_DEBUG) return;
      console.error(chalk.gray(error?.stack || error));
   }

   static verbose(message) {
      console.log(chalk.gray(`  ${message}`));
   }
}
