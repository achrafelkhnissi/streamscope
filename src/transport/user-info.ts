export type UserInfo =
  | { ok: true; credentials: { user: string; password: string } | undefined }
  | { ok: false; message: string };

export function decodeUserInfo(url: URL): UserInfo {
  if (url.username === '' && url.password === '') {
    return { ok: true, credentials: undefined };
  }
  try {
    return {
      ok: true,
      credentials: {
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      },
    };
  } catch {
    return {
      ok: false,
      message:
        'The user name or password in the URL has a % that is not followed by two hex digits.',
    };
  }
}
