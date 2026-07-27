import fs from 'fs';
import path from 'path';

function walk(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const stat = fs.statSync(path.join(dir, file));
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist') {
        walk(path.join(dir, file), fileList);
      }
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      fileList.push(path.join(dir, file));
    }
  }
  return fileList;
}

const srcDir = path.resolve('./src');
const testDir = path.resolve('./tests');
const files = [...walk(srcDir), ...walk(testDir)];

for (const file of files) {
  // Skip the logger itself
  if (file.endsWith('logger.ts')) continue;

  let content = fs.readFileSync(file, 'utf-8');
  let originalContent = content;
  
  // Replace console.log, .warn, .error, .info
  content = content.replace(/console\.log\(/g, 'logger.info(');
  content = content.replace(/console\.error\(/g, 'logger.error(');
  content = content.replace(/console\.warn\(/g, 'logger.warn(');
  content = content.replace(/console\.info\(/g, 'logger.info(');

  if (content !== originalContent) {
    // Add import statement
    const loggerPath = path.resolve(srcDir, 'services', 'logger.js');
    let relPath = path.relative(path.dirname(file), loggerPath);
    relPath = relPath.replace(/\\/g, '/');
    if (!relPath.startsWith('.')) relPath = './' + relPath;

    // Check if logger is already imported
    if (!content.includes('import { logger')) {
      // Find the last import statement or the beginning of the file
      const importMatch = [...content.matchAll(/^import .*?;?$/gm)];
      if (importMatch.length > 0) {
        const lastImport = importMatch[importMatch.length - 1];
        const insertIndex = lastImport.index + lastImport[0].length;
        content = content.slice(0, insertIndex) + `\nimport { logger } from '${relPath}';` + content.slice(insertIndex);
      } else {
        content = `import { logger } from '${relPath}';\n` + content;
      }
    }
    
    fs.writeFileSync(file, content, 'utf-8');
    console.log(`Updated ${file}`);
  }
}
