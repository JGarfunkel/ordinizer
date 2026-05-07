/** @type {import('jest').Config} */
const path = require('path');
const { setupFiles } = require('./jest.config.cjs');
process.env.DATA_ROOT = process.env.DATA_ROOT || path.resolve(__dirname, '../../../nyseeds/data');

module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  displayName: 'integration',
  roots: ['<rootDir>/tests'],
  setupFiles: [...setupFiles],
  testMatch: ['**/integration.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@ordinizer/core(.*)$': '<rootDir>/../../packages/core/src$1',
    '^@civillyengaged/ordinizer-core(.*)$': '<rootDir>/../../packages/core/src$1',
    '^@ordinizer/servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
    '^@civillyengaged/ordinizer-servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
    // No jsdom mock — integration tests use the real jsdom
  },
};
