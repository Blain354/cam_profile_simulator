import type { ReactNode } from 'react';

function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 text-left tracking-normal">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-300">{title}</p>
      <div className="text-neutral-300 text-xs leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

/** Explorer — Cam & actuator */
export const explorerMotorSpeed: ReactNode = (
  <Tip title="Motor speed">
    <p>Rotation speed of the motor driving the lead screw. It sets the linear speed of the cam (together with lead screw pitch): faster motion means the mechanism reaches each Y position sooner.</p>
    <p>Higher RPM shortens valve opening time and shifts flow-versus-time curves; it does not change the cam shape by itself, but it changes how quickly you sweep through the gap curve.</p>
  </Tip>
);

export const explorerDefaultDist: ReactNode = (
  <Tip title="Default distance">
    <p>Nominal radial gap between bushing and cam at the reference configuration. It shifts where the silicone tube starts relative to the cam: larger values generally move first contact to a different stroke.</p>
    <p>Together with deadband and profile height/K, it sets how much squeeze you have before significant flow area opens.</p>
  </Tip>
);

export const explorerThickness: ReactNode = (
  <Tip title="Thickness (cam body)">
    <p>Physical thickness of the cam profile in the direction normal to the drawing. It affects how much material is available to form the curve and can influence feasible curvature and contact geometry in the model.</p>
    <p>
      This value should match the dimensions taken from the CAD: if you change the part in CAD, update this parameter accordingly so the simulation stays consistent with the design.
    </p>
  </Tip>
);

export const explorerHeight: ReactNode = (
  <Tip title="Height (stroke)">
    <p>Vertical stroke over which the cam profile is defined. A larger height spreads the opening motion over more travel; a smaller height makes the same gap change happen in a shorter Y range (often steeper effective slopes).</p>
  </Tip>
);

export const explorerK: ReactNode = (
  <Tip title="Curve gain (K)">
    <p>Dimensionless gain on the cam lift law: higher K makes the profile open the gap more aggressively for the same stroke, lower K makes it gentler.</p>
    <p>It strongly shapes flow vs Y: it is the main “shape” knob once height and deadband are fixed.</p>
  </Tip>
);

export const explorerDeadband: ReactNode = (
  <Tip title="Deadband">
    <p>Range of Y where the mechanism is designed to stay essentially closed before the cam takes over (mechanical slack / pre-travel). Wider deadband delays where the tube begins to open along Y.</p>
  </Tip>
);

export const explorerTubeId: ReactNode = (
  <Tip title="Tube inner diameter">
    <p>Inner diameter of the pneumatic tube. Together with OD and compliance, it sets the annulus thickness and how much the section can swell under pressure before the inner passage opens.</p>
  </Tip>
);

export const explorerTubeOd: ReactNode = (
  <Tip title="Tube outer diameter">
    <p>Outer diameter of the tube. With ID, defines the rubber section; larger OD with the same ID means more wall and usually different stiffness and gap at rest.</p>
  </Tip>
);

export const explorerPressure: ReactNode = (
  <Tip title="Supply pressure">
    <p>Upstream air pressure driving the pneumatic circuit. Higher pressure increases the force available to expand the tube and push flow once an opening exists.</p>
    <p>Shown also in kPa for quick SI reference.</p>
  </Tip>
);

export const explorerCompliance: ReactNode = (
  <Tip title="Compliance (mm / MPa)">
    <p>Empirical radial expansion of the tube per megapascal of internal pressure. It replaces a generic hardness number with a direct elastic response used in the model.</p>
    <p>The “Opening” readout is the static radial swell at the current pressure — the gap component that must be closed before choked flow can start.</p>
  </Tip>
);

export const explorerChamberVol: ReactNode = (
  <Tip title="Chamber volume">
    <p>Dead volume of the downstream chamber used when dynamic filling/emptying is modeled. At 0, the simulation uses a simpler static flow model; above 0, dynamics couple pressure, volume, and flow.</p>
  </Tip>
);

/** Profile Builder — system / target / solver */
export const builderMotorSpeed: ReactNode = (
  <Tip title="Motor speed (solver)">
    <p>Same physical meaning as in the Explorer: it sets linear cam speed for the solved trajectory and therefore timing of opening, equalization, and flow integration.</p>
  </Tip>
);

export const builderTubeId: ReactNode = explorerTubeId;
export const builderTubeOd: ReactNode = explorerTubeOd;
export const builderPressure: ReactNode = explorerPressure;
export const builderCompliance: ReactNode = explorerCompliance;
export const builderThickness: ReactNode = explorerThickness;

export const builderChamberVolume: ReactNode = (
  <Tip title="Target chamber volume">
    <p>Volume the solver tries to match with the dynamic air model: it searches height, K, and deadband so the delivered air hits this target.</p>
    <p>It is not a raw flow-meter reading; the UI explains the free-air equivalent used for pressurization.</p>
  </Tip>
);

export const builderGapAtY0Margin: ReactNode = (
  <Tip title="Gap @ Y=0 margin (mm)">
    <p>
      For each (K, height, deadband) triple, the solver computes the simulated opening gap at Y = 0. The triple is kept only if that gap lies between{' '}
      <strong>theoretical opening − margin</strong> and <strong>theoretical opening</strong> (both in mm). Example: theoretical 0.80 mm and margin 0.10 mm →
      accept gap@Y=0 in [0.70, 0.80] mm.
    </p>
    <p>Larger margin = looser band = more triples can qualify (up to the rest-gap / grid limits).</p>
  </Tip>
);

export const builderKSteps: ReactNode = (
  <Tip title="K samples">
    <p>Number of discrete K (curve gain) values tried in the search grid. More samples explore the gain axis more finely (slower solve), fewer samples are faster but may miss a better fit.</p>
  </Tip>
);

export const builderHSearchMax: ReactNode = (
  <Tip title="Height search max">
    <p>Upper bound on cam height (mm) when scanning the grid. Increase if the solver might need a taller stroke to meet volume; decrease to restrict the search space.</p>
  </Tip>
);

export const builderHeightSteps: ReactNode = (
  <Tip title="Height grid steps">
    <p>Number of height samples between the minimum and the max. Finer steps give smoother exploration of height at higher computational cost.</p>
  </Tip>
);

export const builderDeadbandMin: ReactNode = (
  <Tip title="Deadband search minimum">
    <p>Lower end of the deadband range scanned by the solver (mm). Candidates below this are not tried.</p>
  </Tip>
);

export const builderDeadbandMax: ReactNode = (
  <Tip title="Deadband search maximum">
    <p>Upper end of the deadband range scanned by the solver (mm). Must stay above the minimum.</p>
  </Tip>
);

export const builderDefaultDistMargin: ReactNode = (
  <Tip title="Rest gap factor / margin">
    <p>
      <strong>Default:</strong> rest gap (default_distance) is fixed for the whole solve:{' '}
      <strong>(theoretical opening × this factor) − 0.25 mm</strong> — the subtraction matches CAD, where default_distance is the bushing centered on the axis; the simulation adds the same 0.25 mm radial play when computing the physical gap. Only K, height, and deadband are searched on the grid.
    </p>
    <p>
      <strong>Advanced “max per cell”:</strong> for each (K, height, deadband), the solver binary-searches the largest rest gap that keeps gap@Y=0 at or below the theoretical opening, then applies this factor on that maximum.
    </p>
    <p>Lower factor = smaller rest gap / more conservative.</p>
  </Tip>
);

export const builderAggressivity: ReactNode = (
  <Tip title="Aggressivity (after solve)">
    <p>
      After a successful solve, feasible triples are ordered by the <strong>candidate ranking</strong> method you chose before SOLVE (equalization time, 5–25% linear rise-rate, 5–95% exponential fit, or static flow at a chosen Y). If there are 100 or fewer feasible triples, the slider lists all of them. If there are more than 100, the UI keeps 100 evenly spaced along that ordering, always including the two extremes. This slider moves through that list in real time without re-running the solver.
    </p>
  </Tip>
);

export const builderCandidateRankEqualization: ReactNode = (
  <Tip title="Rank by: equalization time (after Y=0)">
    <p>
      Uses the <strong>dynamic chamber</strong> model. For each feasible cam, we measure the time from the nominal opening crossing at <strong>Y = 0</strong> until chamber absolute pressure reaches the same threshold as the “Equalized” marker on the pressure chart (≥ 99% of supply). Longer times = more gradual pressurization (slider left); shorter times = snappier (slider right).
    </p>
    <p>
      Requires <strong>Chamber volume &gt; 0</strong> so the pressure trace exists. If the dynamic model is off, this mode falls back poorly (tie-break only); prefer another ranking or enable a chamber volume.
    </p>
  </Tip>
);

export const builderCandidateRankFlow2080: ReactNode = (
  <Tip title="Rank by: static flow 5%–25% rise-rate">
    <p>
      Ranks by how fast <strong>static</strong> delivery (L/min) ramps between <strong>5% and 25%</strong> of the monotone flow envelope on the opening stroke for <strong>Y ≥ 0</strong>, in L/min per mm of cam travel (early ramp only). Gradual = lower rise-rate, snappy = higher.
    </p>
    <p>
      Does not use chamber pressure—only the static flow vs Y curve—so it is meaningful even when chamber volume is zero.
    </p>
  </Tip>
);

export const builderCandidateRankFlowAtY: ReactNode = (
  <Tip title="Rank by: static flow at a fixed Y">
    <p>
      Ranks feasible triples by interpolated <strong>static</strong> flow (L/min) on the monotone envelope at one cam travel <strong>Y</strong> (mm, <strong>Y ≥ 0</strong> on the opening stroke). Lower flow at that Y = more gradual (slider left); higher flow = snappier (slider right).
    </p>
    <p>
      Set the Y position below (default 1 mm). If the simulation does not reach that Y, the value at the end of the stroke is used. Independent of chamber dynamics.
    </p>
  </Tip>
);

export const builderCandidateRankFlowYPosition: ReactNode = (
  <Tip title="Y for “flow at Y” ranking">
    <p>
      Cam travel in mm where static delivery is read for ordering candidates. Typical values are between the start of motion and mid-stroke (e.g. 0.5–2 mm). Must match what you care about for “how open” the valve feels at a given displacement.
    </p>
  </Tip>
);

export const builderCandidateRankFlowExp: ReactNode = (
  <Tip title="Rank by: exponential fit (flow vs Y)">
    <p>
      Fits static flow vs Y (for <strong>Y ≥ 0</strong>) to <code>Q(Y) ≈ Q<sub>sat</sub>(1 − e<sup>−kY</sup>)</code> by scanning <code>k</code> (1/mm) to minimize squared error. <strong>Q<sub>sat</sub></strong> is the peak monotone static flow on the stroke. <strong>Smaller k</strong> = slower ramp (more gradual, slider left); <strong>larger k</strong> = faster approach to the plateau (snappier, slider right).
    </p>
    <p>
      The fit uses only samples where monotone flow lies between <strong>5% and 95%</strong> of <code>Q<sub>sat</sub></code> (wide transient band, excluding the extreme foot and the saturation plateau). Requires enough samples in that band; otherwise the solver falls back like a very low <code>k</code>.
    </p>
  </Tip>
);

export const builderFixK: ReactNode = (
  <Tip title="Fix K (curve gain)">
    <p>When enabled, K is held fixed and the solver only searches height and deadband on the grid. Use this when you already know the cam curvature gain and want to tune stroke and deadband for volume and opening feel.</p>
  </Tip>
);

export const builderFixedK: ReactNode = (
  <Tip title="Fixed K value">
    <p>Curve gain used for the whole solve when “Fix K” is on (same meaning as Explorer / simulation K).</p>
  </Tip>
);

export const builderExperienceNote: ReactNode = (
  <Tip title="Experience note">
    <p>Free-form context saved with the builder experience (design intent, assumptions, why this solve was selected).</p>
    <p>This text appears in the experience browser/preview to help future you quickly decide whether to reuse this profile.</p>
  </Tip>
);

export const builderTheoreticalGapStat: ReactNode = (
  <Tip title="Theoretical opening gap">
    <p>Geometric opening reference at Y=0 computed from tube dimensions, pressure and compliance assumptions. It is the baseline used to define admissible gap targets for the solver.</p>
  </Tip>
);

export const builderAcceptableGapStat: ReactNode = (
  <Tip title="Acceptable gap@Y=0">
    <p>Acceptance band used as a hard feasibility filter: each (K, height, deadband) candidate must produce a simulated gap@Y=0 inside this interval.</p>
    <p>After solving, Aggressivity lets you browse feasible solutions in the order set by your <strong>candidate ranking</strong> choice (linear 5–25%, exponential 5–95%, or equalization time), without rerunning the solver.</p>
  </Tip>
);

export const builderPressurizationTargetStat: ReactNode = (
  <Tip title="Pressurization target">
    <p>Equivalent free-air volume target the solver tries to deliver to pressurize the configured chamber from atmosphere to line pressure.</p>
  </Tip>
);

export const builderLinearSpeedStat: ReactNode = (
  <Tip title="Linear speed">
    <p>Cam translation speed derived from motor speed and lead screw pitch. It directly impacts opening/response time and dynamic pressure evolution.</p>
  </Tip>
);
