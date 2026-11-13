import { describe, expect, it } from 'vitest';
import {
  checkDevelopmentPaths,
  checkSurfaceName,
  colorThemes,
  devToolsPort,
  profileSettings,
  screenshotName,
  vscodeArguments,
  vscodeEnvironment,
} from '../../benchmark/view/launch';

const paths = {
  userDataDir: '/tmp/ssv-1/ud',
  extensionsDir: '/tmp/ssv-1/ext',
  developmentPaths: ['/repo', '/repo/spike'],
  driver: '/repo/out/benchmark/view-driver.js',
  workspace: '/tmp/ssv-1/ws',
};

describe('checkSurfaceName', () => {
  it.each(['webview', 'native-fs', 'm6'])('accepts %s', (name) => {
    expect(checkSurfaceName(name)).toBeUndefined();
  });

  it.each(['../x', 'Webview', 'a/b', ''])('rejects %j', (name) => {
    expect(checkSurfaceName(name)).toBe('Use lowercase letters, digits and hyphens for --surface.');
  });
});

describe('profileSettings', () => {
  it('keeps the settings that quiet the throwaway profile and sets no theme by default', () => {
    const settings = profileSettings();

    expect(settings).toMatchObject({
      'workbench.startupEditor': 'none',
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
    });
    expect(settings).not.toHaveProperty('workbench.colorTheme');
  });

  it.each([
    'Default Dark Modern',
    'Default Light Modern',
    'Default High Contrast',
    'Default High Contrast Light',
  ])('writes the requested theme into the profile settings: %s', (theme) => {
    const settings = profileSettings(theme);

    expect(settings['workbench.colorTheme']).toBe(theme);
    expect(settings['telemetry.telemetryLevel']).toBe('off');
  });

  it('accepts exactly the four default themes', () => {
    expect(colorThemes).toEqual([
      'Default Dark Modern',
      'Default Light Modern',
      'Default High Contrast',
      'Default High Contrast Light',
    ]);
  });

  it.each(['Solarized Dark', 'default dark modern', '', 'Default Dark Modern\n'])(
    'refuses the theme %j',
    (theme) => {
      expect(() => profileSettings(theme)).toThrow(
        'Use one of Default Dark Modern, Default Light Modern, Default High Contrast, Default High Contrast Light for --theme.',
      );
    },
  );
});

describe('vscodeArguments', () => {
  it('opens no debugging port for a stream run', () => {
    const args = vscodeArguments({ ...paths, walkthrough: false, platform: 'darwin' });

    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
  });

  it('lets VS Code pick the debugging port for a walkthrough', () => {
    const args = vscodeArguments({ ...paths, walkthrough: true, platform: 'darwin' });

    expect(args).toContain('--remote-debugging-port=0');
  });

  it('keeps the Chromium sandbox on macOS and turns it off on Linux', () => {
    const mac = vscodeArguments({ ...paths, walkthrough: false, platform: 'darwin' });
    const linux = vscodeArguments({ ...paths, walkthrough: false, platform: 'linux' });

    expect(mac).not.toContain('--no-sandbox');
    expect(mac).not.toContain('--disable-gpu-sandbox');
    expect(linux).toContain('--no-sandbox');
    expect(linux).toContain('--disable-gpu-sandbox');
  });

  it('loads every development path, runs the driver and opens the workspace last', () => {
    const args = vscodeArguments({ ...paths, walkthrough: false, platform: 'darwin' });

    expect(args).toContain('--extensionDevelopmentPath=/repo');
    expect(args).toContain('--extensionDevelopmentPath=/repo/spike');
    expect(args).toContain('--extensionTestsPath=/repo/out/benchmark/view-driver.js');
    expect(args).toContain('--user-data-dir=/tmp/ssv-1/ud');
    expect(args.at(-1)).toBe('/tmp/ssv-1/ws');
  });
});

describe('checkDevelopmentPaths', () => {
  const executable =
    '/repo/.vscode-test/vscode-darwin-arm64-1.146.0/Visual Studio Code.app/Contents/MacOS/Code';

  it('accepts folders that do not contain VS Code', () => {
    expect(() => {
      checkDevelopmentPaths(['/tmp/ssv-1/streamscope', '/repo-spike', '/repo/spike'], executable);
    }).not.toThrow();
  });

  it.each(['/repo', '/repo/.vscode-test', '/'])(
    'refuses %s, which holds the built-in themes VS Code would then pick from',
    (folder) => {
      expect(() => {
        checkDevelopmentPaths(['/tmp/ssv-1/streamscope', folder], executable);
      }).toThrow(`The development extension folder ${folder} contains VS Code at ${executable}`);
    },
  );
});

describe('vscodeEnvironment', () => {
  it('passes only the variables VS Code needs plus the benchmark contract', () => {
    const environment = vscodeEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/synthetic',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp/',
        GITHUB_TOKEN: 'synthetic-token',
        NPM_TOKEN: 'synthetic-token',
        ELECTRON_RUN_AS_NODE: '1',
      },
      { STREAMSCOPE_BENCHMARK: '1' },
    );

    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/synthetic',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/',
      STREAMSCOPE_BENCHMARK: '1',
    });
  });
});

describe('devToolsPort', () => {
  it('reads the port VS Code reports on 127.0.0.1', () => {
    expect(
      devToolsPort('Warning: x\nDevTools listening on ws://127.0.0.1:55643/devtools/browser/abc\n'),
    ).toBe(55643);
  });

  it.each(['nothing yet', 'DevTools listening on ws://0.0.0.0:9222/devtools/browser/abc'])(
    'finds no port in %j',
    (text) => {
      expect(devToolsPort(text)).toBeUndefined();
    },
  );
});

describe('screenshotName', () => {
  it('reads the name of a request that carries the run token', () => {
    expect(screenshotName('/run-token/screenshot?name=webview-detail', 'run-token')).toBe(
      'webview-detail',
    );
  });

  it.each<[string | undefined, string]>([
    ['/other/screenshot?name=webview-detail', 'a different token'],
    ['/run-token/screenshot?name=../escape', 'a name with a path'],
    ['/run-token/elsewhere?name=webview-detail', 'another path'],
    ['//', 'a path that is not a URL'],
    [undefined, 'no URL'],
  ])('rejects %j (%s)', (url) => {
    expect(screenshotName(url, 'run-token')).toBeUndefined();
  });
});
