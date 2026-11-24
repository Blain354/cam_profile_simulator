/**
 * Export MiniValve Core Configuration (.mvcc v1) files compatible with SR_Unit_Cluster.
 * Strict v1 schema: exact field set for `pendulum` (no extra keys).
 */

import type { LinkageParams } from '../LinkageExplorer';

export const MVCC_FORMAT = 'mvcc' as const;
export const MVCC_SCHEMA_VERSION = 1 as const;
export const BAR_SYSTEM_SCHEMA_VERSION = 1 as const;

export interface MvccDocument {
  format: typeof MVCC_FORMAT;
  schema_version: typeof MVCC_SCHEMA_VERSION;
  name: string;
  description: string;
  source_app: string;
  exported_at: string;
  bar_system: Record<string, unknown>;
}

export function slugifyMvccFilename(name: string, fallback = 'minivalve-config'): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || fallback}.mvcc`;
}

export function buildPendulumMvccDocument(
  name: string | null | undefined,
  params: LinkageParams,
  opts?: { description?: string; exportedAt?: string },
): MvccDocument {
  const cleanName = (name ?? '').trim() || 'MiniValve Pendulum';
  return {
    format: MVCC_FORMAT,
    schema_version: MVCC_SCHEMA_VERSION,
    name: cleanName,
    description: opts?.description?.trim() ?? '',
    source_app: 'cam-profile-sim',
    exported_at: opts?.exportedAt ?? new Date().toISOString(),
    bar_system: {
      schema_version: BAR_SYSTEM_SCHEMA_VERSION,
      mechanism_type: 'pendulum',
      bar1_length: params.bar1_length,
      bar2_length: params.bar2_length,
      foot_length: params.foot_length,
      foot_angle_deg: params.foot_angle_deg,
      pad_length: params.pad_length,
      fixed_height: params.fixed_height,
      anchor_distance: params.anchor_distance,
      pivot_offset: params.pivot_offset,
      tube_center_x: params.tube_center_x,
      pin_diameter: params.pin_diameter,
      preload: params.preload,
      stroke: params.stroke,
      target_exponent: params.target_exponent,
      tube_id: params.tube_id,
      tube_od: params.tube_od,
      input_pressure_kpa: params.input_pressure_kpa,
      compliance: params.compliance,
      tube_model: params.tube_model,
      tube_shore_a: params.tube_shore_a,
      chamber_volume_ml: params.chamber_volume_ml,
      motor_speed: params.motor_speed,
      lead_screw_pitch: params.lead_screw_pitch,
      speed_factor: params.speed_factor,
      motor_torque_mnm: params.motor_torque_mnm,
      screw_diameter: params.screw_diameter,
      screw_friction: params.screw_friction,
      member_modulus_mpa: params.member_modulus_mpa,
      member_width: params.member_width,
      member_thickness: params.member_thickness,
      contact_deformation: Boolean(params.contact_deformation),
      link_curved: Boolean(params.link_curved),
      compliant: Boolean(params.compliant),
      carriage_clamped: Boolean(params.carriage_clamped),
      carriage_pin_diameter: params.carriage_pin_diameter,
      carriage_pin_length: params.carriage_pin_length,
      member_strength_mpa: params.member_strength_mpa,
      carriage_pin_strength_mpa: params.carriage_pin_strength_mpa,
    },
  };
}

export function downloadMvccDocument(doc: MvccDocument): void {
  const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = slugifyMvccFilename(doc.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
