export interface InstallEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** `navigator.standalone` (iOS Safari only, undefined elsewhere). */
  navigatorStandalone: boolean | undefined;
  /** `matchMedia("(display-mode: standalone)").matches`. */
  displayModeStandalone: boolean;
}

/** iPhone, iPod, or iPad (including iPadOS, which reports itself as a touch-capable Mac). */
export function isIos(env: Pick<InstallEnv, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  if (/iPhone|iPad|iPod/.test(env.userAgent)) return true;
  return env.platform === "MacIntel" && env.maxTouchPoints > 1;
}

/** Safari proper, as opposed to other iOS browsers (Chrome, Firefox, Edge, Opera) and in-app views. */
export function isIosSafari(env: InstallEnv): boolean {
  if (!isIos(env)) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo/.test(env.userAgent)) return false;
  return env.userAgent.includes("Safari");
}

export function isStandalone(
  env: Pick<InstallEnv, "navigatorStandalone" | "displayModeStandalone">,
): boolean {
  return env.navigatorStandalone === true || env.displayModeStandalone;
}

/** True when we should nudge the person to add the app to their home screen. */
export function shouldShowIosInstallHint(env: InstallEnv): boolean {
  return isIosSafari(env) && !isStandalone(env);
}

export function readInstallEnv(): InstallEnv {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
  };
}
