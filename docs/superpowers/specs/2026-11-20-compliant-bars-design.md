# Compliant Bars

Onglet à côté de Pendulum. Pendulum ne change pas. Le sous-onglet de recherche de ce tab s'appelle Solver.

Trois courbes de Bézier cubiques, forme au repos = pose à Y = 0 (tube juste fermé, preload inclus).

- L : ancre `(-anchor_distance, l_thickness / 2)` (contour tangent à la surface du bas `y = 0`), encastrée, jusqu'à la jonction `(junction_x, junction_y)`.
- R : jonction jusqu'au pivot `(±pivot_offset, closed_carriage_height)`, articulé (rotation libre, translation imposée par le chariot).
- Pied : jonction jusqu'au contact. `pinch_y` est libre. `pinch_x` place la face du bout à `closed_gap - preload` de la paroi.

Chaque poignée est `(u, v)` : fraction le long de la corde, décalage latéral en mm (positif = gauche du sens corde). Une épaisseur dans le plan par courbe. L'épaisseur hors plan, le module et la limite accompagnent le tube, le pivot et la course. Ce que le Solver en fait varier est dit plus bas.

Là où deux épaisseurs se recouvrent (hors voisinage de la jonction), les nœuds sont reliés par des barres rigides et les tronçons réels de la zone sont raidis : un seul bloc, la flexion reste dans les portées libres.

`passes` (`compute_compliant`) : le chariot ouvre le tube ; la contrainte sur la course reste sous la résistance du matériau fois `stress_limit_factor` (borné de 0,05 à 1 ; 1 si les contraintes sont absentes) ; le pied scelle à Y = 0 ; la pièce reste au-delà du jeu de coque au repos, à +course et à −course (sauf le voisinage de l'ancrage de L) et au-delà du jeu de pivot sur des poses échantillonnées (sauf l'œil de R). Plus près que le jeu demandé compte comme un contact ; sans contraintes, ce jeu est `CLEARANCE_MIN`. Un jeu de tube nul, un plafond de rotation nul et l'absence de zone d'exclusion ne contraignent pas. Le pincement reste entre son plancher et le plafond du boîtier. L'onglet envoie les siennes (`DEFAULT_CONSTRAINTS`).

Le sous-onglet Solver cherche dans le temps (`POST /api/compliant/solve/jobs`, `backend/compliant_solver.py`). L'objectif se choisit : ouverture horizontale du contact entre Y = 0 et Y = 0,25 mm (défaut de l'onglet), course jusqu'à 90 % du plein débit, pente moyenne de débit, ou hauteur de pincement et angle d'attaque. La méthode se choisit : hybride (hypercube latin, gradient, Nelder-Mead ; défaut), balayage, évolution différentielle, ou polissage depuis la forme affichée. Le gagnant est revu sur la grille fine et n'est gardé que s'il passe encore. `POST /api/compliant/solve` reste le tirage court classé sur la pente moyenne.

Le Solver peut aussi faire varier la hauteur de chariot, le décalage et le côté du pivot, la course, la précharge et l'épaisseur hors plan, quand ces dimensions ne sont pas figées. L'onglet les fige au départ. Le module, la limite, le tube, la pression et `tube_model` ne sont pas cherchés.
