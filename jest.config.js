module.exports = {
  // Beside the other `yarn verify` steps: half the cores for the test files.
  ...(process.env.VERIFY_RUNNING ? { maxWorkers: '50%' } : {}),
  reporters: process.env.CI ? ['default', 'jest-junit'] : ['default'],
  coverageReporters: ['text', 'lcov'],
  preset: '@react-native/jest-preset',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/example/', '<rootDir>/lib/'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/native/**',
    '!src/**/__tests__/**',
  ],
  coverageThreshold: {
    global: { statements: 90, branches: 80, functions: 90, lines: 90 },
  },
};
