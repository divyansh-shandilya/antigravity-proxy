import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('src/dashboard');
const dest = path.resolve('dist/dashboard');

if (fs.existsSync(src)) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log('Copied dashboard assets to dist/dashboard');
} else {
  console.warn('Dashboard source directory not found:', src);
}
