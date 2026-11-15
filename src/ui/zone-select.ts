/** The time zone list every time tool shows: this device first, then UTC, then zones by region. */
import { listTimeZones } from '../core/time/zones';
import type { OptionGroup } from './components';

/** The value that stands for "this device's zone". */
export const DEVICE_ZONE = '';

/** True when the select lists value (a zone from a link must be one this browser offers). */
export function hasOption(select: HTMLSelectElement, value: string): boolean {
  return [...select.options].some(o => o.value === value);
}

export function zoneGroups(device: string): OptionGroup[] {
  const byRegion = new Map<string, { value: string; label: string }[]>();
  for (const zone of listTimeZones()) {
    if (zone === 'UTC') continue;
    const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region)!.push({ value: zone, label: zone.replaceAll('_', ' ') });
  }
  return [
    { label: null, options: [{ value: DEVICE_ZONE, label: `This device (${device})` }, { value: 'UTC', label: 'UTC' }] },
    ...[...byRegion.entries()].map(([label, options]) => ({ label, options })),
  ];
}
