/**
 * @jest-environment node
 */
// A server-rendered page (Next.js…) imports the React DOM entry and renders
// its buttons with no browser: nothing touches a browser API, and the app-
// global hooks use their server snapshots (no picker, no Cast).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

it('imports and renders on a server', () => {
  expect(typeof (globalThis as { document?: unknown }).document).toBe(
    'undefined'
  );
  const entry = require('../index') as typeof import('../index');
  expect(typeof entry.Player).toBe('function');
  expect(renderToStaticMarkup(createElement(entry.RoutePicker))).toBe('');
  expect(renderToStaticMarkup(createElement(entry.CastButton))).toBe('');
});
