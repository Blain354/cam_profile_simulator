"""
Simulation du profil de came - Valve pneumatique
=================================================
Simule l'ouverture d'une valve pneumatique commandée par un moteur N20
via vis sans-fin M3. Un bushing (pinch roller Ø3 mm) roule sur un tube
pincé contre un mur ayant un profil de came.

Le profil comporte:
  - Une section droite (deadband) où le tube est complètement pincé
  - Une section exponentielle (approx. spline degré 2) où le tube s'ouvre

Convention: Y=0 = centre du deadband.
  - Section exponentielle: de Y = -deadband/2  vers le haut  (+Y)
  - La came commence à -deadband/2 et monte jusqu'à height.
"""

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch
from math import exp

# ============================================================
# PARAMÈTRES D'ENTRÉE (modifier ici)
# ============================================================
motor_speed       = 100     # RPM du moteur N20
height            = 2.0     # mm - étendue en Y de la section exponentielle
thickness         = 2.5    # mm - épaisseur en X du profil de came (ouverture max)
K                 = 2.0     # gain (forme de la courbe exponentielle)
deadband          = 1.5     # mm - zone morte
default_distance  = 0.35    # mm - écart bushing↔mur en section droite
bushing_diameter  = 3.0     # mm
lead_screw_pitch  = 0.5     # mm par révolution (vis M3)

# ============================================================
# PARAMÈTRES DÉRIVÉS
# ============================================================
bushing_radius = bushing_diameter / 2.0  # 1.5 mm

# Position X du mur dans la section droite
# Bushing centre à X=0, surface à X=bushing_radius
# Mur droit à X = bushing_radius + default_distance
X_wall_straight = bushing_radius + default_distance

# Point de contrôle Bézier: position Y relative depuis le début de la courbe
ctrl_length = height * (1.0 - (exp(K) - 1.0) / (K * exp(K)))

# ============================================================
# PROFIL DE CAME (Bézier quadratique)
# ============================================================
# Convention côté gauche de l'image:
#   - La came commence à Y = -deadband/2 (jonction avec section droite)
#   - La came monte jusqu'à Y = -deadband/2 + height (fin de la courbe expo)
#   - Dans la section droite (Y <= -deadband/2), X_wall = X_wall_straight
#   - Dans la section expo, X_wall augmente (le mur s'éloigne → tube s'ouvre)
#
# Points de contrôle du Bézier quadratique (Y, X):
#   P0 = (-deadband/2,                X_wall_straight)             -> jonction
#   P1 = (-deadband/2 + ctrl_length,  X_wall_straight)             -> tangence
#   P2 = (-deadband/2 + height,       X_wall_straight + thickness) -> fin

P0 = np.array([-deadband / 2.0, X_wall_straight])
P1 = np.array([-deadband / 2.0 + ctrl_length, X_wall_straight])
P2 = np.array([-deadband / 2.0 + height, X_wall_straight + thickness])

# Échantillonnage fin du Bézier
N_BEZIER = 500
t_bez = np.linspace(0, 1, N_BEZIER)

# B(t) = (1-t)²·P0 + 2t(1-t)·P1 + t²·P2
bezier_points = (
    np.outer((1 - t_bez)**2, P0)
    + np.outer(2 * t_bez * (1 - t_bez), P1)
    + np.outer(t_bez**2, P2)
)
bezier_Y = bezier_points[:, 0]  # coordonnée Y
bezier_X = bezier_points[:, 1]  # coordonnée X (position du mur)

# ============================================================
# PROFIL COMPLET DE LA CAME
# ============================================================
# Section droite: de Y = -deadband/2 - 5mm à Y = -deadband/2
# (on prolonge bien en dessous pour couvrir l'étendue du bushing)
N_STRAIGHT = 200
straight_Y = np.linspace(-deadband / 2.0 - 10.0, -deadband / 2.0, N_STRAIGHT)
straight_X = np.full(N_STRAIGHT, X_wall_straight)

# Section au-delà de la courbe expo (extension droite à la valeur max)
N_EXT = 100
ext_Y = np.linspace(-deadband / 2.0 + height, -deadband / 2.0 + height + 5.0, N_EXT)
ext_X = np.full(N_EXT, X_wall_straight + thickness)

# Assemblage du profil complet
cam_Y = np.concatenate([straight_Y, bezier_Y, ext_Y])
cam_X = np.concatenate([straight_X, bezier_X, ext_X])

# ============================================================
# CALCUL DE LA DISTANCE MINIMALE BUSHING ↔ CAME
# ============================================================
# Le bushing (cercle de rayon R) est centré à (X=0, Y=Y_pos).
# Pour chaque position Y_pos, on calcule:
#   min_gap = min_i( sqrt(cam_X[i]² + (cam_Y[i] - Y_pos)²) ) - R_bushing
#
# Plage de simulation: Y_start = -deadband/2 - 2mm  →  Y_end = deadband

Y_start = -deadband / 2.0 - 2.0
Y_end   = deadband
N_SIM   = 1000
Y_positions = np.linspace(Y_start, Y_end, N_SIM)

min_gaps = np.zeros(N_SIM)

for i, Y_pos in enumerate(Y_positions):
    # Distance du centre du bushing à chaque point de la came
    distances = np.sqrt(cam_X**2 + (cam_Y - Y_pos)**2)
    # Distance minimale de la surface du bushing à la came
    min_gaps[i] = distances.min() - bushing_radius

# Valeur d'ouverture à Y=0
gap_at_Y0 = np.interp(0.0, Y_positions, min_gaps)

# ============================================================
# CINÉMATIQUE DU MOTEUR
# ============================================================
# Vitesse linéaire de la came
linear_speed = motor_speed * lead_screw_pitch  # mm/min
linear_speed_mm_s = linear_speed / 60.0        # mm/s

# Temps pour parcourir la plage de simulation
total_travel = Y_end - Y_start
travel_time_s = total_travel / linear_speed_mm_s

# Axe temporel correspondant
time_axis = np.linspace(0, travel_time_s, N_SIM)

# ============================================================
# GRAPHIQUES
# ============================================================
fig, axes = plt.subplots(1, 3, figsize=(18, 6), gridspec_kw={'width_ratios': [1, 1.2, 1.2]})
fig.suptitle(
    f"Simulation profil de came – Valve pneumatique\n"
    f"Moteur {motor_speed} RPM | K={K} | Deadband={deadband} mm | "
    f"Épaisseur came={thickness} mm | Distance défaut={default_distance} mm",
    fontsize=11, fontweight='bold'
)

# --- Plot 1: Profil de came + bushing ---
ax1 = axes[0]
ax1.set_title("Profil de came (coupe X-Y)")
ax1.plot(cam_X, cam_Y, 'g-', linewidth=2, label='Surface came')
ax1.axhline(y=-deadband / 2.0, color='orange', linestyle='--', alpha=0.7, label='Début zone expo')
ax1.axhline(y=deadband / 2.0, color='red', linestyle='--', alpha=0.7, label='Fin deadband')
ax1.axhline(y=0, color='gray', linestyle=':', alpha=0.5, label='Centre deadband (Y=0)')

# Bushing à quelques positions
for y_b in [Y_start, -deadband / 2.0, 0, Y_end]:
    circle = Circle((0, y_b), bushing_radius, fill=False, edgecolor='darkorange',
                     linewidth=1.5, linestyle='-', alpha=0.6)
    ax1.add_patch(circle)
    ax1.plot(0, y_b, 'o', color='darkorange', markersize=2)

ax1.set_xlabel("X (mm)")
ax1.set_ylabel("Y (mm)")
ax1.set_aspect('equal')
ax1.legend(fontsize=7, loc='upper left')
ax1.grid(True, alpha=0.3)

# --- Plot 2: Distance minimale vs Position Y ---
ax2 = axes[1]
ax2.set_title("Distance min bushing ↔ came vs Position Y")
ax2.plot(Y_positions, min_gaps, 'b-', linewidth=2)

# Zones annotées
ax2.axvspan(-deadband / 2.0, deadband / 2.0, alpha=0.15, color='red', label='Deadband')
ax2.axvspan(-deadband / 2.0, -deadband / 2.0 + height, alpha=0.10, color='green', label='Zone exponentielle')
ax2.axvline(x=-deadband / 2.0, color='orange', linestyle='--', alpha=0.7)
ax2.axvline(x=deadband / 2.0, color='red', linestyle='--', alpha=0.7)
ax2.axhline(y=default_distance, color='gray', linestyle=':', alpha=0.5, label=f'Distance défaut ({default_distance} mm)')
ax2.axhline(y=gap_at_Y0, color='magenta', linestyle='-', linewidth=1.5, alpha=0.8,
            label=f'Ouverture à Y=0 : {gap_at_Y0:.3f} mm')
ax2.plot(0, gap_at_Y0, 'o', color='magenta', markersize=6, zorder=5)

ax2.set_xlabel("Position Y (mm)")
ax2.set_ylabel("Distance minimale (mm)")
ax2.legend(fontsize=7)
ax2.grid(True, alpha=0.3)

# --- Plot 3: Distance minimale vs Temps ---
ax3 = axes[2]
ax3.set_title(f"Distance min vs Temps ({motor_speed} RPM)")
ax3.plot(time_axis * 1000, min_gaps, 'r-', linewidth=2)  # temps en ms

ax3.axhline(y=default_distance, color='gray', linestyle=':', alpha=0.5,
            label=f'Distance défaut ({default_distance} mm)')
ax3.axhline(y=gap_at_Y0, color='magenta', linestyle='-', linewidth=1.5, alpha=0.8,
            label=f'Ouverture à Y=0 : {gap_at_Y0:.3f} mm')

ax3.set_xlabel("Temps (ms)")
ax3.set_ylabel("Distance minimale (mm)")
ax3.legend(fontsize=7)
ax3.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig("simulation_came_profile.png", dpi=150, bbox_inches='tight')
plt.show()

# ============================================================
# RÉSUMÉ CONSOLE
# ============================================================
print("=" * 60)
print("  RÉSULTATS DE LA SIMULATION")
print("=" * 60)
print(f"  Moteur:               {motor_speed} RPM")
print(f"  Vitesse linéaire:     {linear_speed_mm_s:.3f} mm/s")
print(f"  Pas de vis (M3):      {lead_screw_pitch} mm/rev")
print(f"  Deadband:             {deadband} mm")
print(f"  Hauteur section expo: {height} mm")
print(f"  Épaisseur came (X):   {thickness} mm")
print(f"  Gain K:               {K}")
print(f"  Distance défaut:      {default_distance} mm")
print(f"  Diamètre bushing:     {bushing_diameter} mm")
print(f"  ctrl_length Bézier:   {ctrl_length:.4f} mm")
print(f"  Plage simulation Y:   [{Y_start:.2f}, {Y_end:.2f}] mm")
print(f"  Temps total:          {travel_time_s*1000:.1f} ms")
print(f"  Distance min:         {min_gaps.min():.4f} mm")
print(f"  Distance max:         {min_gaps.max():.4f} mm")
print(f"  Ouverture à Y=0:      {gap_at_Y0:.3f} mm")
print("=" * 60)
