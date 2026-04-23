module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@ordinizer/servercore(.*)$': '<rootDir>/../../packages/servercore/src$1',
    '^@ordinizer/core(.*)$': '<rootDir>/../../packages/core/src$1'
  }
};