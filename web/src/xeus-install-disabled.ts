/** Build-time replacement for upstream's networked package solver/installer. */
export function install(): never {
  throw new Error(
    "Runtime package installation is disabled; rebuild the pinned environment.",
  );
}
export const pipInstall = install;
export const pipUninstall = install;
export const remove = install;
