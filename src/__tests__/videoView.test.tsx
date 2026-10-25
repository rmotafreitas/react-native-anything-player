// <VideoView>: the React DOM view and the React Native Web / Expo web view put the player's picture
// in its element (`attachTo`) and takes it out when it goes; the native view
// (iOS and Android) hands the player id and its props to the native component.

import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { fake } from './FakeNative';
import './FakeVideoNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

jest.mock('../native/VideoViewNativeComponent', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: object) => <View testID="native-video" {...props} />,
  };
});

import { Player } from '../Player';
import { VideoView as DomVideoView } from '../react/VideoView';

// Jest resolves the .native file by default; the shared one serves the web.
const { VideoView: WebVideoView } = jest.requireActual<
  typeof import('../components/VideoView')
>('../components/VideoView.tsx');
const { VideoView: NativeVideoView } = jest.requireActual<
  typeof import('../components/VideoView.native')
>('../components/VideoView.native.tsx');

let player: Player;
let attachTo: jest.SpyInstance;

beforeEach(() => {
  fake.calls = [];
  player = new Player({ video: true });
  attachTo = jest.spyOn(player, 'attachTo').mockImplementation(() => {});
});

afterEach(async () => {
  await player.release();
});

describe('VideoView on the web', () => {
  it('puts the picture in its element with the default fit and no controls', async () => {
    await render(<WebVideoView player={player} />);
    expect(attachTo).toHaveBeenCalledTimes(1);
    expect(attachTo).toHaveBeenCalledWith(expect.anything(), {
      contentFit: 'contain',
      nativeControls: false,
    });
  });

  it('draws a black, clipped box that takes the app style', async () => {
    await render(<WebVideoView player={player} style={{ aspectRatio: 1.5 }} />);
    const box = screen.root!;
    expect(StyleSheet.flatten(box.props.style)).toEqual({
      overflow: 'hidden',
      backgroundColor: 'black',
      aspectRatio: 1.5,
    });
  });

  it('takes the picture out when it unmounts', async () => {
    const view = await render(<WebVideoView player={player} />);
    await view.unmount();
    expect(attachTo).toHaveBeenLastCalledWith(null);
  });

  it('attaches again when the fit or the controls change', async () => {
    const view = await render(<WebVideoView player={player} />);
    await view.rerender(
      <WebVideoView player={player} contentFit="cover" nativeControls />
    );
    expect(attachTo.mock.calls.map((c) => c.slice(1))).toEqual([
      [{ contentFit: 'contain', nativeControls: false }],
      [],
      [{ contentFit: 'cover', nativeControls: true }],
    ]);
  });

  it('moves the picture to a new player', async () => {
    const other = new Player({ video: true });
    const otherAttach = jest
      .spyOn(other, 'attachTo')
      .mockImplementation(() => {});
    const view = await render(<WebVideoView player={player} />);
    await view.rerender(<WebVideoView player={other} />);
    expect(attachTo).toHaveBeenLastCalledWith(null);
    expect(otherAttach).toHaveBeenCalledTimes(1);
    await view.unmount();
    expect(otherAttach).toHaveBeenLastCalledWith(null);
    await other.release();
  });

  it('does not touch a player that was released', async () => {
    const view = await render(<WebVideoView player={player} />);
    attachTo.mockClear();
    await player.release();
    await view.unmount();
    expect(attachTo).not.toHaveBeenCalled();
    const second = await render(<WebVideoView player={player} />);
    expect(attachTo).not.toHaveBeenCalled();
    await second.unmount();
  });
});

describe('VideoView on a device', () => {
  it('gives the native view the player id, the fit and the controls', async () => {
    await render(
      <NativeVideoView player={player} contentFit="fill" nativeControls />
    );
    const view = screen.getByTestId('native-video');
    expect(view.props).toMatchObject({
      playerId: player.id,
      contentFit: 'fill',
      nativeControls: true,
    });
    expect(attachTo).not.toHaveBeenCalled();
  });

  it('defaults to a letterboxed picture without controls, in a black box', async () => {
    await render(
      <NativeVideoView player={player} style={{ aspectRatio: 16 / 9 }} />
    );
    const view = screen.getByTestId('native-video');
    expect(view.props).toMatchObject({
      contentFit: 'contain',
      nativeControls: false,
    });
    expect(StyleSheet.flatten(view.props.style)).toEqual({
      overflow: 'hidden',
      backgroundColor: 'black',
      aspectRatio: 16 / 9,
    });
  });
});

describe('VideoView in React DOM', () => {
  it('puts the picture in its div with the default fit and no controls', async () => {
    await render(<DomVideoView player={player} />);
    expect(attachTo).toHaveBeenCalledTimes(1);
    expect(attachTo).toHaveBeenCalledWith(expect.anything(), {
      contentFit: 'contain',
      nativeControls: false,
    });
  });

  it('is a positioned div with the app class and style', async () => {
    await render(
      <DomVideoView
        player={player}
        className="player"
        style={{ aspectRatio: '16 / 9' }}
      />
    );
    expect(screen.root!.type).toBe('div');
    expect(screen.root!.props.className).toBe('player');
    expect(screen.root!.props.style).toEqual({
      position: 'relative',
      aspectRatio: '16 / 9',
    });
  });

  it('lets the app style override the base position', async () => {
    await render(
      <DomVideoView player={player} style={{ position: 'fixed' }} />
    );
    expect(screen.root!.props.style).toEqual({ position: 'fixed' });
  });

  it('takes the picture out when it unmounts', async () => {
    const view = await render(<DomVideoView player={player} />);
    await view.unmount();
    expect(attachTo).toHaveBeenLastCalledWith(null);
  });

  it('attaches again when the fit or the controls change', async () => {
    const view = await render(<DomVideoView player={player} />);
    await view.rerender(
      <DomVideoView player={player} contentFit="fill" nativeControls />
    );
    expect(attachTo.mock.calls.map((c) => c.slice(1))).toEqual([
      [{ contentFit: 'contain', nativeControls: false }],
      [],
      [{ contentFit: 'fill', nativeControls: true }],
    ]);
  });

  it('does not touch a player that was released', async () => {
    await player.release();
    const view = await render(<DomVideoView player={player} />);
    await view.unmount();
    expect(attachTo).not.toHaveBeenCalled();
  });

  it('does not take the picture out of a player released while it showed', async () => {
    const view = await render(<DomVideoView player={player} />);
    attachTo.mockClear();
    await player.release();
    await view.unmount();
    expect(attachTo).not.toHaveBeenCalled();
  });
});
