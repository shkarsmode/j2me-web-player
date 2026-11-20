export interface Translation {
  open_jar: string;
  drop_hint: string;
  privacy_hint: string;
  tagline: string;
  my_games: string;
  empty_hint: string;
  delete_title: string;
  play: string;
  toast_cannot_open: string;
  toast_not_found: string;
  toast_cannot_start: string;
  onscreen_keys: string;
  fullscreen: string;
  back_to_list: string;
  back_label: string;
  controls: string;
  got_it: string;
  game_exited: string;
  game_crashed: string;
  to_list: string;
  restart: string;
  joystick: string;
  numpad: string;
  soft_left: string;
  soft_right: string;
}

const en: Translation = {
  open_jar: 'Open .jar',
  drop_hint: 'or drop a game file here',
  privacy_hint: 'Files are never uploaded to a server — games and saves stay in this browser only.',
  tagline: 'Java games from feature phones — in your browser on PC and phone',
  my_games: 'My games',
  empty_hint: 'Nothing here yet. Open a .jar file and it will appear.',
  delete_title: 'Remove from list',
  play: 'Play',
  toast_cannot_open: 'Could not open file: ',
  toast_not_found: 'Game not found',
  toast_cannot_start: 'Could not start game: ',
  onscreen_keys: 'On-screen keys',
  fullscreen: 'Full screen',
  back_to_list: 'To game list',
  back_label: 'Back',
  controls: 'Controls',
  got_it: 'Got it',
  game_exited: 'Game exited',
  game_crashed: 'Game crashed',
  to_list: 'To list',
  restart: 'Restart',
  joystick: 'Joystick',
  numpad: 'Numeric keypad',
  soft_left: '◀ Soft',
  soft_right: 'Soft ▶',
};

export default en;
