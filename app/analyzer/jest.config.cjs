/** @type {import('jest').Config} */
const path = require('path');
process.env.DATA_ROOT = process.env.DATA_ROOT || path.resolve(__dirname, '../../../nyseeds/data');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'unit',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '!**/integration.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
    '^.+\\.(js|mjs)$': ['babel-jest', {
      presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
    }],
  },
  transformIgnorePatterns: [],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@ordinizer/core(.*)$': '<rootDir>/../../packages/core/src$1',
    '^@civillyengaged/ordinizer-core(.*)$': '<rootDir>/../../packages/core/src$1',
    '^@ordinizer/servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
    '^@civillyengaged/ordinizer-servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
    // Shim the pure-ESM @exodus/bytes sub-paths so jsdom loads in Jest CJS mode
    '^@exodus/bytes/(.*)$': '<rootDir>/jest-mocks/exodus-bytes-encoding-lite.cjs',
  },
};
