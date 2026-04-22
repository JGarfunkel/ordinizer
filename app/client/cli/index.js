#!/usr/bin/env node

/**
 * Ordinizer CLI
 * Copy templates and components into your project (shadcn-style)
 */

import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('ordinizer')
  .description('CLI tool for Ordinizer - copy templates and components')
  .version('0.1.0');

// Init command - setup provider and base config
program
  .command('init')
  .description('Initialize Ordinizer in your project')
  .action(async () => {
    try {
      const cwd = process.cwd();
      const templatesDir = path.join(__dirname, '../templates');
      
      // Copy init files
      const initFiles = [
        'lib/queryClient.ts',
        'lib/ordinizerSetup.tsx',
      ];

      console.log('🚀 Initializing Ordinizer...\n');

      for (const file of initFiles) {
        const sourcePath = path.join(templatesDir, file);
        const targetPath = path.join(cwd, 'src', file);
        
        // Check if file exists
        if (await fs.pathExists(targetPath)) {
          console.log(`⚠️  ${file} already exists, skipping...`);
          continue;
        }

        // Ensure directory exists
        await fs.ensureDir(path.dirname(targetPath));
        
        // Copy file
        await fs.copy(sourcePath, targetPath);
        console.log(`✅ Created ${file}`);
      }

      console.log('\n✨ Ordinizer initialized successfully!');
      console.log('\nNext steps:');
      console.log('1. Wrap your app with OrdinizerAppWrapper');
      console.log('2. Import ordinizer/client/styles in your main CSS');
      console.log('3. Run: npx ordinizer add <template-name>');
      
    } catch (error) {
      console.error('❌ Error initializing:', error.message);
      process.exit(1);
    }
  });

// Add command - copy template files
program
  .command('add <template>')
  .description('Add a template component to your project')
  .action(async (templateName) => {
    try {
      const cwd = process.cwd();
      const templatesDir = path.join(__dirname, '../templates');
      const registryPath = path.join(templatesDir, 'registry.json');
      
      // Load registry
      const registry = await fs.readJSON(registryPath);
      const template = registry.templates[templateName];

      if (!template) {
        console.error(`❌ Template "${templateName}" not found`);
        console.log('\nAvailable templates:');
        Object.keys(registry.templates).forEach(name => {
          console.log(`  - ${name}: ${registry.templates[name].description}`);
        });
        process.exit(1);
      }

      console.log(`📦 Adding template: ${template.name}\n`);

      // Copy template files
      for (const file of template.files) {
        const sourcePath = path.join(templatesDir, file);
        const targetPath = path.join(cwd, 'src', file);
        
        // Check if file exists
        if (await fs.pathExists(targetPath)) {
          console.log(`⚠️  ${file} already exists, skipping...`);
          continue;
        }

        // Ensure directory exists
        await fs.ensureDir(path.dirname(targetPath));
        
        // Copy file
        await fs.copy(sourcePath, targetPath);
        console.log(`✅ Created ${file}`);
      }

      // Check for required UI components
      if (template.ui && template.ui.length > 0) {
        console.log('\n📋 Required shadcn/ui components:');
        template.ui.forEach(ui => {
          console.log(`  - ${ui}`);
        });
        console.log('\nRun: npx shadcn@latest add <component>');
      }

      console.log('\n✨ Template added successfully!');
      
    } catch (error) {
      console.error('❌ Error adding template:', error.message);
      process.exit(1);
    }
  });

// List command - show available templates
program
  .command('list')
  .description('List available templates')
  .action(async () => {
    try {
      const registryPath = path.join(__dirname, '../templates/registry.json');
      const registry = await fs.readJSON(registryPath);

      console.log('📚 Available Ordinizer templates:\n');
      
      Object.entries(registry.templates).forEach(([name, template]) => {
        console.log(`${name}`);
        console.log(`  ${template.description}`);
        if (template.requires) {
          console.log(`  Requires: ${template.requires.join(', ')}`);
        }
        console.log('');
      });
      
    } catch (error) {
      console.error('❌ Error listing templates:', error.message);
      process.exit(1);
    }
  });

program.parse();
