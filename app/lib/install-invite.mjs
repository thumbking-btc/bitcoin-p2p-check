export const INSTALL_INVITE_DISMISS_KEY = "bitcoin-p2p-install-invite-dismissed-until-v1";
export const INSTALL_INVITE_DISMISS_MS = 24 * 60 * 60 * 1000;

export function getInstallInviteDismissedUntil(now = Date.now()) {
  return now + INSTALL_INVITE_DISMISS_MS;
}

export function isInstallInviteSuppressed(value, now = Date.now()) {
  if (value == null || value === "") return false;
  const dismissedUntil = Number(value);
  return Number.isFinite(dismissedUntil) && dismissedUntil > now;
}
