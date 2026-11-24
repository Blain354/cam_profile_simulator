import { describe, expect, it } from 'vitest';
import { COMPLIANT_DEFAULTS, DEFAULT_CONSTRAINTS } from '../compliant/types';
import {
  MVCC_FORMAT,
  MVCC_SCHEMA_VERSION,
  buildCompliantMvccDocument,
  buildPendulumMvccDocument,
  slugifyMvccFilename,
} from './mvcc';
import type { LinkageParams } from '../LinkageExplorer';

describe('mvcc export helpers', () => {
  it('builds a strict v1 compliant_bars .mvcc document with all 44 keys and no extras', () => {
    const doc = buildCompliantMvccDocument('auto-v5', COMPLIANT_DEFAULTS, {
      constraints: DEFAULT_CONSTRAINTS,
      exportedAt: '2026-11-24T05:00:00Z',
    });
    expect(doc.format).toBe(MVCC_FORMAT);
    expect(doc.schema_version).toBe(MVCC_SCHEMA_VERSION);
    expect(doc.name).toBe('auto-v5');
    expect(doc.source_app).toBe('cam-profile-sim');
    expect(doc.bar_system.schema_version).toBe(1);
    expect(doc.bar_system.mechanism_type).toBe('compliant_bars');
    expect(doc.bar_system.motor_speed).toBe(100);
    expect(doc.bar_system.speed_factor).toBe(0.85);
    expect(Object.keys(doc.bar_system)).toHaveLength(44);
  });

  it('uses effective pinch_y when target_pinch_from_top_mm is set', () => {
    const doc = buildCompliantMvccDocument('pinned-pinch', { ...COMPLIANT_DEFAULTS, closed_carriage_height: 8 }, {
      constraints: { ...DEFAULT_CONSTRAINTS, target_pinch_from_top_mm: 3.5 },
    });
    expect(doc.bar_system.pinch_y).toBeCloseTo(12.5);
  });

  it('builds a strict v1 pendulum .mvcc document stripping cam-profile-sim extra fields', () => {
    const pendulum: LinkageParams = {
      linkage_type: 'pendulum',
      bar1_length: 11.95,
      bar2_length: 14.43,
      lever_length: 16.5,
      foot_length: 1.5,
      foot_angle_deg: 100,
      pad_length: 1.0,
      fixed_height: 0,
      anchor_distance: 4.79,
      pivot_offset: 4.0,
      tube_center_x: 8.0,
      pin_diameter: 1.0,
      preload: 0.1,
      stroke: 3.0,
      target_exponent: 1.0,
      tube_id: 2.0,
      tube_od: 3.0,
      input_pressure_kpa: 100,
      compliance: 0.7,
      tube_model: 'fem',
      tube_shore_a: 50,
      chamber_volume_ml: 10,
      motor_speed: 100,
      lead_screw_pitch: 0.5,
      speed_factor: 0.85,
      motor_torque_mnm: 30,
      screw_diameter: 3.0,
      screw_friction: 0.3,
      member_modulus_mpa: 2500,
      member_width: 2.0,
      member_thickness: 3.0,
      contact_deformation: true,
      link_curved: true,
      link_curve_mode: 'tangent',
      link_curve_flip: false,
      link_radius: 10,
      compliant: true,
      carriage_clamped: false,
      carriage_pin_diameter: 1.5,
      carriage_pin_length: 8.0,
      member_strength_mpa: 40,
      carriage_pin_strength_mpa: 300,
      pivot_inverted: false,
      assembly_clearance: 0.5,
      linkage_plane_spacing: 5,
      carriage_block_width: 8,
      carriage_block_length: 8,
      carriage_block_height: 4,
      carriage_block_offset: 0,
    };
    const doc = buildPendulumMvccDocument('Custom Interessant 3', pendulum);
    expect(doc.bar_system.mechanism_type).toBe('pendulum');
    expect(Object.keys(doc.bar_system)).toHaveLength(39);
    expect('lever_length' in doc.bar_system).toBe(false);
    expect('link_curve_mode' in doc.bar_system).toBe(false);
  });

  it('slugifies filenames cleanly', () => {
    expect(slugifyMvccFilename('Custom HOT v4!')).toBe('custom-hot-v4.mvcc');
    expect(slugifyMvccFilename('')).toBe('minivalve-config.mvcc');
  });
});
