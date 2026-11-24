import { describe, expect, it } from 'vitest';
import {
  buildPendulumMvccDocument,
  slugifyMvccFilename,
} from './mvcc';
import type { LinkageParams } from '../LinkageExplorer';

describe('mvcc export helpers', () => {
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
