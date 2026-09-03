import { spawn } from 'node:child_process';

export function getOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (process.platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

/**
 * Launch the user's browser at `url`, and always print the URL first.
 *
 * The launcher exiting 0 means the *launcher* succeeded, not that a human saw
 * the page: over SSH, in a container, or on a headless box, `open`/`xdg-open`
 * can hand the URL to something that goes nowhere and still exit 0. Only
 * printing on failure therefore leaves exactly the sessions that most need the
 * URL — the ones with no reachable browser — staring at a callback server that
 * never resolves.
 *
 * Every caller is an OAuth PKCE flow that then blocks waiting for the callback,
 * so one extra line is cheap next to a hang, and it makes the flow completable
 * by hand or by relaying the link to whoever is actually at a browser.
 */
export function openBrowser(url: string): void {
  console.error('[Auth] 로그인 페이지를 엽니다. 열리지 않으면 직접 열어주세요:');
  console.error(url);

  const { command, args } = getOpenCommand(url);
  const child = spawn(command, args, {
    stdio: 'ignore',
    windowsHide: true,
  });
  let reported = false;

  // Still worth saying when the launcher itself failed: it tells the user the
  // link above is now their only route, rather than leaving them to guess
  // whether a browser is on its way.
  const reportFallback = (): void => {
    if (reported) return;
    reported = true;
    console.error('[Auth] 브라우저를 자동으로 열지 못했습니다 — 위 주소를 직접 열어주세요.');
  };

  child.on('error', reportFallback);
  child.on('close', (code) => {
    if (code !== 0) {
      reportFallback();
    }
  });
}
