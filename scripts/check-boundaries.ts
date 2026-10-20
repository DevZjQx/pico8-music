import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Zero-dependency version of the boundary rules in the project-structure
 * skill: shared -> features -> app, one public entry per feature, no barrels.
 */

const ENTRY = 'feature.ts';

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function checkBoundaries(root: string): string[] {
  const src = join(root, 'src');
  const violations: string[] = [];
  const files = walk(src);

  for (const file of files) {
    const relativeFile = toPosix(relative(src, file));
    if (relativeFile === ENTRY || relativeFile.endsWith(`/${ENTRY}`)) continue;
    if (relativeFile.endsWith('/index.ts')) {
      violations.push(`${relativeFile}: no index.ts below a module entry; import the concrete file`);
    }
  }

  for (const file of files) {
    const relativeFile = toPosix(relative(src, file));
    const sourceLayer = layerOf(relativeFile);
    const source = readFileSync(file, 'utf8');

    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) continue;
      const target = toPosix(relative(src, resolve(file, '..', specifier)));
      const targetLayer = layerOf(target);

      if (sourceLayer.layer === 'feature') {
        if (targetLayer.layer === 'app') {
          violations.push(`${relativeFile} -> ${target}: features must not import app`);
          continue;
        }
        if (targetLayer.layer === 'feature' && targetLayer.feature !== sourceLayer.feature) {
          const entry = `features/${targetLayer.feature}/${ENTRY}`;
          if (target !== entry) {
            violations.push(
              `${relativeFile} -> ${target}: cross-feature imports must use ${entry}`,
            );
          }
        }
      }

      if (sourceLayer.layer === 'app' && targetLayer.layer === 'feature') {
        const entry = `features/${targetLayer.feature}/${ENTRY}`;
        if (target !== entry) {
          violations.push(`${relativeFile} -> ${target}: app must import ${entry}`);
        }
      }

      if (sourceLayer.layer === 'shared' && targetLayer.layer !== 'shared') {
        violations.push(`${relativeFile} -> ${target}: shared modules must not import ${targetLayer.layer}`);
      }
    }
  }

  return violations;
}

type Layer =
  | { readonly layer: 'app' | 'shared' }
  | { readonly layer: 'feature'; readonly feature: string };

function layerOf(path: string): Layer {
  if (path === 'app' || path.startsWith('app/')) return { layer: 'app' };
  const match = /^features\/([^/]+)\//.exec(path);
  if (match?.[1]) return { layer: 'feature', feature: match[1] };
  return { layer: 'shared' };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const root = resolve(import.meta.dirname, '..');
  const violations = checkBoundaries(root);
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('boundaries: ok');
  }
}
