#!/usr/bin/env node

/**
 * Graph Validate CLI
 * Validates architecture constraints against the code graph
 *
 * Usage:
 *   npm run graph:validate
 *   npm run graph:validate -- --strict
 *   npm run graph:validate -- --file src/engine/calculations/columns.ts
 */

import { ArchitectureEngine } from '../engines/architecture-engine.js';
import { loadConfig } from '../config.js';
import GraphIndexManager from '../graph/index.js';
import { MemgraphClient } from '../graph/client.js';

async function main() {
  const args = process.argv.slice(2);
  const isStrict = args.includes('--strict');
  const writeViolations = args.includes('--write');
  const fileIndex = args.indexOf('--file');
  const targetFile = fileIndex >= 0 ? args[fileIndex + 1] : undefined;

  console.error('🏗️  Architecture Validator');
  if (targetFile) {
    console.error(`📄 Validating: ${targetFile}`);
  } else {
    console.error('📄 Validating all files');
  }
  console.error(`🔒 Strict mode: ${isStrict ? 'ON' : 'OFF'}\n`);

  try {
    // Load configuration
    const config = await loadConfig();

    // Create in-memory graph index (MVP - no Memgraph connection needed for validation)
    console.error('📊 Preparing validation engine...');
    const index = new GraphIndexManager();
    console.error('✅ Ready\n');

    // Run validation
    console.error('🔍 Checking architecture constraints...\n');
    const layers = config.architecture.layers.map(layer => ({
      ...layer,
      description: layer.description || layer.name
    }));
    const engine = new ArchitectureEngine(
      layers,
      config.architecture.rules,
      index
    );
    const filesToValidate = targetFile ? [targetFile] : undefined;
    const result = await engine.validate(filesToValidate);
    const violations = result.violations || [];

    // Write violations to Memgraph if --write flag is set
    if (writeViolations && violations.length > 0) {
      try {
        const client = new MemgraphClient();
        await client.connect();
        await engine.writeViolationsToMemgraph(client, violations);
        await client.disconnect();
      } catch (error) {
        console.warn('⚠️  Could not write violations to Memgraph:', error instanceof Error ? error.message : String(error));
      }
    }

    // Display results
    if (violations.length === 0) {
      console.error('✅ No violations found!');
    } else {
      console.error(`⚠️  Found ${violations.length} violation(s):\n`);
      violations.forEach((violation, index) => {
        const icon =
          violation.severity === 'error' ? '❌' : '⚠️';
        console.error(`${icon} ${index + 1}. ${violation.message}`);
        console.error(`   File: ${violation.file}`);
        console.error(`   Layer: ${violation.layer}`);
        console.error('');
      });

      const errorCount = violations.filter((v) => v.severity === 'error').length;
      const warningCount = violations.filter((v) => v.severity === 'warn').length;

      console.error(`Summary: ${errorCount} error(s), ${warningCount} warning(s)`);

      if (isStrict && errorCount > 0) {
        console.error('\n🛑 Strict mode: exiting with error code 1');
        process.exit(1);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Validation failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
