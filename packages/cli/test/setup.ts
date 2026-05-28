/**
 * test/setup.ts — vitest global setup.
 *
 * Sets FORCE_COLOR=1 so chalk's color-support detection sees color enabled
 * during tests. ink-testing-library renders into a non-TTY stream by default,
 * which suppresses ANSI emission and would make color-related assertions
 * (e.g. `expect(frame).toMatch(/\x1b\[[^m]*36/)`) impossible to verify.
 * Setting this here runs before any test or `import 'ink'` chain, so chalk
 * picks it up at module-load time.
 */

process.env.FORCE_COLOR = '1';
