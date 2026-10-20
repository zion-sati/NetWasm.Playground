/** The run setting's stored value for "use the browser's zone". */
export const browserTimeZoneSetting = '';

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** UTC first, then every IANA zone the browser knows. */
export function timeZoneChoices(): string[] {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...zones.filter(zone => zone !== 'UTC')];
}

export function parseTimeZoneSetting(value: string | null): string {
  return value !== null && (value === browserTimeZoneSetting || timeZoneChoices().includes(value))
    ? value : browserTimeZoneSetting;
}

/** The TZ a run uses for a stored setting. */
export function resolveTimeZone(setting: string): string {
  return setting === browserTimeZoneSetting ? browserTimeZone() : setting;
}
