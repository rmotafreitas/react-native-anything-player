module.exports = {
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
