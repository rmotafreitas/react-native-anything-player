import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { fake } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { CastButton } from '../components/CastButton';
import { RoutePicker as IosRoutePicker } from '../components/RoutePicker.ios';
import { useCastStatus, useRoutePickerAvailable } from '../hooks';
import { Player } from '../Player';

// Jest resolves the iOS file by default; the shared one serves Android and the web.
const { RoutePicker } = jest.requireActual<
  typeof import('../components/RoutePicker')
>('../components/RoutePicker.tsx');

beforeEach(() => {
  fake.calls = [];
  fake.rejectNext = null;
  fake.routePickerAvailable = true;
  fake.castStatus = { state: 'notConnected', device: null };
});

function Probe() {
  const cast = useCastStatus();
  const available = useRoutePickerAvailable();
  return (
    <Text testID="out">
      {cast.state}|{cast.device ?? '-'}|{String(available)}
    </Text>
  );
}

const out = () => screen.getByTestId('out').props.children.join('');

describe('hooks', () => {
  it('follow the Cast state and the picker availability', async () => {
    await render(<Probe />);
    expect(out()).toBe('notConnected|-|true');
    await act(async () => {
      fake.castStatus = { state: 'connected', device: 'TV' };
      fake.emit({ type: 'castState', state: 'connected', device: 'TV' });
    });
    expect(out()).toBe('connected|TV|true');
    await act(async () => {
      fake.routePickerAvailable = false;
      fake.emit({ type: 'routePickerAvailability', available: false });
    });
    expect(out()).toBe('connected|TV|false');
  });
});

describe('<RoutePicker />', () => {
  it('opens the picker for its player and shows when it plays elsewhere', async () => {
    const player = new Player();
    await render(
      <RoutePicker player={player} color="gray" activeColor="blue" />
    );
    const button = screen.getByRole('button', { name: 'Choose audio output' });
    const tint = () =>
      (
        screen.getByRole('button').children[0] as {
          props: { style: { tintColor: string } };
        }
      ).props.style.tintColor;
    expect(tint()).toBe('gray');
    await fireEvent.press(button);
    expect(fake.calls).toContainEqual(['showRoutePicker', player.id]);
    await act(async () => {
      fake.emitStatus(player.id, {
        seq: 9,
        route: { kind: 'cast', name: 'TV' },
      });
    });
    expect(tint()).toBe('blue');
    await player.release();
  });

  it('works without a player and swallows a refusal', async () => {
    await render(<RoutePicker />);
    fake.rejectNext = { code: 'ROUTE_PICKER_UNAVAILABLE', message: 'none' };
    await fireEvent.press(screen.getByRole('button'));
    expect(fake.calls).toContainEqual(['showRoutePicker', null]);
  });

  it('renders nothing where there is no picker', async () => {
    fake.routePickerAvailable = false;
    await render(<RoutePicker />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('<RoutePicker /> on iOS', () => {
  it("renders the system's AirPlay button", async () => {
    await render(<IosRoutePicker size={30} color="gray" activeColor="blue" />);
    const view = screen.getByLabelText('Choose audio output');
    expect(view.props).toMatchObject({
      tintColor: 'gray',
      activeTintColor: 'blue',
    });
    expect(view.props.style).toEqual([{ width: 30, height: 30 }, undefined]);
  });

  it('renders nothing without the native view', async () => {
    fake.routePickerAvailable = false;
    await render(<IosRoutePicker />);
    expect(screen.queryByLabelText('Choose audio output')).toBeNull();
  });
});

describe('<CastButton />', () => {
  it('configures Cast and opens the chooser', async () => {
    await render(<CastButton />);
    const button = screen.getByRole('button', { name: 'Cast' });
    expect(fake.calls).toContainEqual(['configureCast', {}]);
    await fireEvent.press(button);
    expect(fake.calls).toContainEqual(['showCastPicker']);
  });

  it('names the receiver while casting', async () => {
    fake.castStatus = { state: 'connected', device: 'Kitchen' };
    await render(<CastButton />);
    expect(
      screen.getByRole('button', { name: 'Casting to Kitchen' })
    ).toBeTruthy();
  });

  it('is hidden with no devices or no Cast', async () => {
    fake.castStatus = { state: 'noDevices', device: null };
    await render(<CastButton accessibilityLabel="Cast it" />);
    expect(screen.queryByRole('button')).toBeNull();
    await act(async () => {
      fake.castStatus = { state: 'connecting', device: 'TV' };
      fake.emit({ type: 'castState', state: 'connecting', device: 'TV' });
    });
    expect(screen.getByRole('button', { name: 'Cast it' })).toBeTruthy();
  });
});
