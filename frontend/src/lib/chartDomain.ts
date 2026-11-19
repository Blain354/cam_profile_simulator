import type { AxisDomainItem } from 'recharts';
import type { ChartDomainSettings } from '../components';

type DomainPair = Readonly<[AxisDomainItem, AxisDomainItem]>;

/** The axis domain the settings ask for: `auto` while the axis is on Auto, else the typed min and max. */
export function chartDomain(settings: ChartDomainSettings, axis: 'x' | 'y', auto?: DomainPair): DomainPair | undefined {
  if (axis === 'x') return settings.autoX ? auto : [settings.xMin, settings.xMax];
  return settings.autoY ? auto : [settings.yMin, settings.yMax];
}

export function sameDomainSettings(a: ChartDomainSettings, b: ChartDomainSettings): boolean {
  return a.autoX === b.autoX && a.autoY === b.autoY && a.xMin === b.xMin && a.xMax === b.xMax && a.yMin === b.yMin && a.yMax === b.yMax;
}
