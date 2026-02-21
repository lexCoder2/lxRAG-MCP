#!/usr/bin/env node

/**
 * Test the TypeScript parser on a few sample files
 * Validates that the parser works before building the full graph
 */

import * as path from 'path';
import * as fs from 'fs';
import TypeScriptParser from './parsers/typescript-parser.js';

async function testParser() {
  console.log('🧪 Testing TypeScript Parser\n');

  const parser = new TypeScriptParser();
  await parser.initialize();

  // Test files to parse
  const testFiles = [
    'src/types/building.types.ts',
    'src/hooks/useBuildingState.ts',
    'src/engine/calculations/columns.ts',
    'src/context/CodeContext.tsx',
    'src/components/drawing/GridCanvas.tsx',
  ];

  const projectRoot = process.cwd();
  let successCount = 0;
  let failureCount = 0;

  for (const testFile of testFiles) {
    const filePath = path.join(projectRoot, testFile);

    if (!fs.existsSync(filePath)) {
      console.log(`⏭️  SKIP: ${testFile} (not found)`);
      continue;
    }

    try {
      console.log(`🔍 Parsing: ${testFile}`);
      const parsed = parser.parseFile(filePath);

      console.log(`   📄 File: ${parsed.relativePath}`);
      console.log(`   📊 LOC: ${parsed.LOC}`);
      console.log(`   🔧 Functions: ${parsed.functions.length}`);
      console.log(`   📦 Classes/Interfaces: ${parsed.classes.length}`);
      console.log(`   📥 Imports: ${parsed.imports.length}`);
      console.log(`   📤 Exports: ${parsed.exports.length}`);
      console.log('');

      successCount++;

      // Show sample of parsed items
      if (parsed.functions.length > 0) {
        console.log(`   Sample functions:`);
        parsed.functions.slice(0, 3).forEach((fn) => {
          console.log(`     - ${fn.name} (line ${fn.startLine})`);
        });
        console.log('');
      }

      if (parsed.imports.length > 0) {
        console.log(`   Sample imports:`);
        parsed.imports.slice(0, 3).forEach((imp) => {
          console.log(`     - from '${imp.source}'`);
        });
        console.log('');
      }
    } catch (error) {
      console.error(`   ❌ Parse error: ${error}`);
      failureCount++;
      console.log('');
    }
  }

  // Summary
  console.log('📈 Test Summary:');
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ❌ Failures: ${failureCount}`);
  console.log(`   📊 Total: ${successCount + failureCount}`);

  process.exit(failureCount > 0 ? 1 : 0);
}

testParser().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
