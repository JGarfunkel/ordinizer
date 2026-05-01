/** @type {import('jest').Config} */
process.env.DATA_ROOT = process.env.DATA_ROOT || '../../../nyseeds/data';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^jsdom$': '<rootDir>/tests/__mocks__/jsdom.js',
    '^@ordinizer/core(.*)$': '<rootDir>/../../packages/core/src$1',
    '^@civillyengaged/ordinizer-core(.*)$': '<rootDir>/../../packages/core/src$1',
    '^@ordinizer/servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
    '^@civillyengaged/ordinizer-servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
  },
};
