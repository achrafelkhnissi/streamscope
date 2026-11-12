const surfaceNamePattern = /^[a-z0-9-]+$/;
const devToolsListening = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//;
const passedVariables = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

export const colorThemes = [
  'Default Dark Modern',
  'Default Light Modern',
  'Default High Contrast',
  'Default High Contrast Light',
] as const;

const profileDefaults = {
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

export interface VscodeLaunch {
  walkthrough: boolean;
  platform: NodeJS.Platform;
  userDataDir: string;
  extensionsDir: string;
  developmentPaths: readonly string[];
  driver: string;
  workspace: string;
}

export function profileSettings(theme?: string): Record<string, string | boolean> {
  if (theme === undefined) {
    return { ...profileDefaults };
  }
  if (!colorThemes.some((accepted) => accepted === theme)) {
    throw new Error(`Use one of ${colorThemes.join(', ')} for --theme.`);
  }
  return { ...profileDefaults, 'workbench.colorTheme': theme };
}

export function checkSurfaceName(name: string): string | undefined {
  return surfaceNamePattern.test(name)
    ? undefined
    : 'Use lowercase letters, digits and hyphens for --surface.';
}

export function vscodeArguments(launch: VscodeLaunch): string[] {
  return [
    ...(launch.platform === 'linux' ? ['--no-sandbox', '--disable-gpu-sandbox'] : []),
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-extensions',
    '--disable-workspace-trust',
    ...(launch.walkthrough ? ['--remote-debugging-port=0'] : []),
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    `--user-data-dir=${launch.userDataDir}`,
    `--extensions-dir=${launch.extensionsDir}`,
    ...launch.developmentPaths.map((folder) => `--extensionDevelopmentPath=${folder}`),
    `--extensionTestsPath=${launch.driver}`,
    launch.workspace,
  ];
}

export function vscodeEnvironment(
  source: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of passedVariables) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return { ...environment, ...extra };
}

export function devToolsPort(text: string): number | undefined {
  const match = devToolsListening.exec(text);
  return match === null ? undefined : Number(match[1]);
}

export function screenshotName(url: string | undefined, token: string): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://127.0.0.1');
  } catch {
    return undefined;
  }
  const name = parsed.searchParams.get('name') ?? '';
  return parsed.pathname === `/${token}/screenshot` && surfaceNamePattern.test(name)
    ? name
    : undefined;
}
