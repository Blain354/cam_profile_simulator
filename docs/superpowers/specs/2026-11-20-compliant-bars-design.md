# Compliant Bars

Onglet à côté de Pendulum. Pendulum ne change pas. Le sous-onglet de recherche de ce tab s'appelle Solver.

Trois courbes de Bézier cubiques, forme au repos = pose à Y = 0 (tube juste fermé, preload inclus).

- L : ancre `(-anchor_distance, 0)`, encastrée, jusqu'à la jonction `(junction_x, junction_y)`.
- R : jonction jusqu'au pivot `(±pivot_offset, closed_carriage_height)`, articulé (rotation libre, translation imposée par le chariot).
- Pied : jonction jusqu'au contact. `pinch_y` est libre. `pinch_x` place la face du bout à `closed_gap - preload` de la paroi.

Chaque poignée est `(u, v)` : fraction le long de la corde, décalage latéral en mm (positif = gauche du sens corde). Une épaisseur dans le plan par courbe. L'épaisseur hors plan, le module et la limite sont le contexte, avec le tube, le pivot, la course.

Là où deux épaisseurs se recouvrent (hors voisinage de la jonction), les nœuds sont reliés par des barres rigides et les tronçons réels de la zone sont raidis : un seul bloc, la flexion reste dans les portées libres.

Contraintes dures du Solver : contrainte sous la limite du matériau sur la course ; aucun contact avec le pivot (sauf l'œil de R) ; aucun contact avec le contour de la coque au repos et en pose dépliée (sauf l'ancrage de L). Parmi les formes admissibles, la plus forte pente moyenne de débit statique `dQ/dY` sur la montée.

Le Solver ne fait pas varier le contexte.
