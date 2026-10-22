// The React DOM buttons (src/react), rendered to markup with their mockHooks
// stubbed: what they show in each state, and what a click calls.
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mockHooks = {
  available: true,
  elsewhere: false,
  cast: { state: 'notConnected', device: null as string | null },
};
const mockSystem = {
  showRoutePicker: jest.fn((_player?: unknown) => Promise.resolve()),
  showCastPicker: jest.fn(() => Promise.reject(new Error('no cast'))),
  configureCast: jest.fn(() => Promise.resolve()),
};

jest.mock('../../core/hooks', () => ({
  useRoutePickerAvailable: () => mockHooks.available,
  usePlaysElsewhere: () => mockHooks.elsewhere,
  useCastStatus: () => mockHooks.cast,
}));
jest.mock('../../core/system', () => ({
  showRoutePicker: (player?: unknown) => mockSystem.showRoutePicker(player),
  showCastPicker: () => mockSystem.showCastPicker(),
  configureCast: () => mockSystem.configureCast(),
}));

import { CastButton } from '../CastButton';
import { RoutePicker } from '../RoutePicker';

const html = (element: ReactElement) => renderToStaticMarkup(element);

beforeEach(() => {
  mockHooks.available = true;
  mockHooks.elsewhere = false;
  mockHooks.cast = { state: 'notConnected', device: null };
  jest.clearAllMocks();
});

describe('RoutePicker (DOM)', () => {
  it('is a button with an SVG icon in the idle or active colour', () => {
    const idle = html(
      createElement(RoutePicker, { color: 'gray', className: 'x' })
    );
    expect(idle).toContain('<button type="button" class="x"');
    expect(idle).toContain('aria-label="Choose audio output"');
    expect(idle).toContain('fill="gray"');
    mockHooks.elsewhere = true;
    expect(
      html(
        createElement(RoutePicker, {
          activeColor: 'blue',
          label: 'Out',
          size: 30,
        })
      )
    ).toMatch(/aria-label="Out".*width="30".*fill="blue"/);
  });

  it('renders nothing without a picker', () => {
    mockHooks.available = false;
    expect(html(createElement(RoutePicker))).toBe('');
  });

  it('opens the picker for its player on click', () => {
    const player = { id: 'p1' } as never;
    const button = RoutePicker({ player }) as ReactElement<{
      onClick: () => void;
    }>;
    button.props.onClick();
    expect(mockSystem.showRoutePicker).toHaveBeenCalledWith(player);
  });
});

describe('CastButton (DOM)', () => {
  it('shows only with devices around, and names the receiver', () => {
    mockHooks.cast = { state: 'noDevices', device: null };
    expect(html(createElement(CastButton))).toBe('');
    mockHooks.cast = { state: 'notConnected', device: null };
    expect(html(createElement(CastButton, { color: 'gray' }))).toMatch(
      /aria-label="Cast".*aria-pressed="false".*fill="gray"/
    );
    mockHooks.cast = { state: 'connected', device: 'Kitchen' };
    expect(html(createElement(CastButton, { activeColor: 'blue' }))).toMatch(
      /aria-label="Casting to Kitchen".*aria-pressed="true".*fill="blue"/
    );
    mockHooks.cast = { state: 'connecting', device: null };
    expect(html(createElement(CastButton, { label: 'TV' }))).toMatch(
      /aria-label="TV".*aria-busy="true"/
    );
  });
});
