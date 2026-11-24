/**
 * Export MiniValve Core Configuration (.mvcc v1) files compatible with SR_Unit_Cluster.
 * Strict v1 schema: exact field sets for `compliant_bars` and `pendulum` (no extra keys).
 */

import type { CompliantParams, SolverConstraints } from '../compliant/types';
import { LOAD_FACTOR, MOTOR_RPM, effectivePinchY } from '../compliant/types';
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

export function buildCompliantMvccDocument(
  name: string | null | undefined,
  params: CompliantParams & { motor_speed?: number; speed_factor?: number },
  opts?: { description?: string; constraints?: SolverConstraints | null; exportedAt?: string },
): MvccDocument {
  const cleanName = (name ?? '').trim() || 'MiniValve Compliant Bars';
  const pinchY = effectivePinchY(params, opts?.constraints);
  const motorSpeed = typeof params.motor_speed === 'number' && Number.isFinite(params.motor_speed)
    ? params.motor_speed
    : MOTOR_RPM;
  const speedFactor = typeof params.speed_factor === 'number' && Number.isFinite(params.speed_factor)
    ? params.speed_factor
    : LOAD_FACTOR;

  return {
    format: MVCC_FORMAT,
    schema_version: MVCC_SCHEMA_VERSION,
    name: cleanName,
    description: opts?.description?.trim() ?? '',
    source_app: 'cam-profile-sim',
    exported_at: opts?.exportedAt ?? new Date().toISOString(),
    bar_system: {
      schema_version: BAR_SYSTEM_SCHEMA_VERSION,
      mechanism_type: 'compliant_bars',
      anchor_distance: params.anchor_distance,
      junction_x: params.junction_x,
      junction_y: params.junction_y,
      pinch_y: pinchY,
      l_u1: params.l_u1,
      l_v1: params.l_v1,
      l_u2: params.l_u2,
      l_v2: params.l_v2,
      r_u1: params.r_u1,
      r_v1: params.r_v1,
      r_u2: params.r_u2,
      r_v2: params.r_v2,
      f_u1: params.f_u1,
      f_v1: params.f_v1,
      f_u2: params.f_u2,
      f_v2: params.f_v2,
      l_thickness: params.l_thickness,
      r_thickness: params.r_thickness,
      f_thickness: params.f_thickness,
      closed_carriage_height: params.closed_carriage_height,
      pivot_offset: params.pivot_offset,
      pivot_inverted: Boolean(params.pivot_inverted),
      stroke: params.stroke,
      preload: params.preload,
      member_depth: params.member_depth,
      member_modulus_mpa: params.member_modulus_mpa,
      member_strength_mpa: params.member_strength_mpa,
      carriage_pin_diameter: params.carriage_pin_diameter,
      tube_center_x: params.tube_center_x,
      tube_id: params.tube_id,
      tube_od: params.tube_od,
      input_pressure_kpa: params.input_pressure_kpa,
      compliance: params.compliance,
      tube_model: params.tube_model,
      tube_shore_a: params.tube_shore_a,
      chamber_volume_ml: params.chamber_volume_ml,
      motor_speed: motorSpeed,
      speed_factor: speedFactor,
      lead_screw_pitch: params.lead_screw_pitch,
      motor_torque_mnm: params.motor_torque_mnm,
      screw_diameter: params.screw_diameter,
      screw_friction: params.screw_friction,
    },
  };
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
