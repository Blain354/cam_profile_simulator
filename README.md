# Simulation came profile

Projet de simulation d'un profil de came pour valve pneumatique, avec:

- un backend FastAPI qui calcule la geometrie de came, les jeux mecaniques et le debit d'air;
- un frontend React/Vite qui permet d'ajuster les parametres et visualiser les courbes;
- un systeme de sauvegarde/chargement de configurations via une base SQLite (avec migration automatique depuis `configs/` legacy).

## A quoi ca sert

Ce projet sert a:

- evaluer l'impact des parametres mecaniques (deadband, epaisseur, K, vitesse moteur, etc.);
- estimer l'ouverture du tube en fonction de la position/du temps;
- approximer le debit pneumatique resultant;
- comparer et conserver des profils de simulation.

## Architecture rapide

- `backend/main.py`: API FastAPI (`/api/simulate`, gestion des configs, healthcheck).
- `backend/simulation.py`: logique numerique de simulation.
- `backend/linkage.py`: mecanismes a barres (onglets Bar Linkage, Lever Linkage et Pendulum Linkage ; Explorer pour la cinematique, Finder pour la recherche ; miroir double gauche-droite et haut-bas) : cinematique du point de pincement, debit statique, traces d'air entrant / sortant d'une chambre sur le cycle 0, +stroke, 0, -stroke, 0 a la vitesse lineaire chargee (vitesse moteur a vide x facteur de charge x pas de vis), bouton Oscillate qui rejoue ce cycle en temps reel et marque ce temps sur les traces, recherche des longueurs de barres et de la distance d'ancrage par tirage aleatoire sur les plages, puis tirages resserres autour des meilleurs. Le pivot du chariot peut s'asseoir du cote de son tube (`pivot_inverted`, Inverted sous Geometry) plutot que du cote oppose a la vis : l'autre mecanisme suit et les deux pivots s'echangent. Le joint garde, sur la course, le cote de la droite ancrage vers pivot que fixe la pose fermee a Y = 0. Quand le pivot est a l'exterieur de la ligne du bras, le lien pousse, en compression. Quand il est du cote tube de cette ligne, le lien tire, en traction : la meme course deplace le joint a l'envers, et le chariot se deplace dans l'autre sens pour ouvrir le tube A. Y reste cette ouverture ; Carriage Y affiche alors `link pulls: carriage runs the other way`. Le coude place le pivot au-dessus du joint, et le lien pousse. Le levier ne tire que si le pivot depasse le joint sous la ligne du levier, ce qui demande un lien court. Le pendule tire quand le pivot est plus loin de la vis que le bras a sa hauteur. Fast response (`response`, defaut) note ensemble une bande morte courte, une pente de debit raide, le debit atteint et une course courte. Au tirage rigide, les quatre objectifs qui choisissent la course (tous sauf Follow target) refusent d'ecraser le tube ferme au-dela de la limite, de rapprocher les deux mecanismes en dessous du jeu d'assemblage, et de travailler a moins de 0,2 mm du point mort des barres. Pour le pendule, le pied et son angle sont cherches aussi. Sous Geometry to search, Pivot side vaut Normal (cote oppose, defaut), Inverted (cote du tube) ou Search both. Chaque cote refait la recherche qu'il ferait seul : Search both garde le plus bas score et, a score egal, le cote normal, et dure le temps des deux recherches. `/api/linkage/optimize` recoit `pivot_side` (`normal`, `inverted`, `both` ; une autre valeur repond 422). Le champ absent, comme un `search` de profil ou du navigateur enregistre avant lui, vaut `normal`. L'Explorer choisit le cote du dessin a part (`pivot_inverted`, recu par `/api/linkage/simulate`). Dans le Finder, une case Fixed garde la dimension a la valeur affichee. `/api/linkage/optimize` ne recoit pas cette case : les deux bornes envoyees sont cette valeur, donc le tirage de `optimize_linkage` reste dessus, et le profil garde la plage d'origine avec la liste des dimensions figees (`search` ; une liste absente n'en fige aucune). Les autres dimensions restent tirees sur leurs plages. Sous Geometry to search, une zone interdite d'ancrage (assemblage) accompagne ces plages : une distance strictement entre ses deux bornes n'est jamais proposee, au tirage rigide comme au passage en poutre du pendule en une piece ; les deux bornes restent admises, leur ordre ne change rien, et deux bornes egales suppriment la zone. `/api/linkage/optimize` recoit `anchor_avoid_min` et `anchor_avoid_max` ; si les deux sont absentes, ou si un `search` de profil ou du navigateur a ete enregistre avant elles, elles sont egales et il n'y a pas de zone. L'Explorer calcule quand meme un ancrage dans la zone (`/api/linkage/simulate` ne la recoit pas) et le signale sous le curseur ; le Finder le signale a cote de la zone. Sous Limits, Pinch height borne la hauteur du centre du pion au-dessus du plan d'ancrage, a Y = 0 et en pose rigide : en dessous de `pinch_height_min`, ou au-dessus de `pinch_height_max` quand ce maximum est strictement positif, la geometrie n'est pas proposee, au tirage rigide comme aux tirages du passage en poutre, qui ne sont gardes que si cette pose rigide est acceptee. Un maximum a 0 ne plafonne pas ; 0 et 0, y compris un `search` de profil ou du navigateur enregistre avant ces champs, laissent ce plan comme plancher et n'ajoutent pas de plafond. `/api/linkage/simulate` ne recoit pas ces bornes. La ligne Pinch point from top plane est ce centre de pion a Y = 0 sur la pose calculee. Une distance d'ancrage figee par Fixed strictement dans la zone ne laisse aucune geometrie. Si la hauteur totale est imposee, la longueur du lien est calculee et la case n'est pas offerte. Les deux mecanismes travaillent dans des plans paralleles (`linkage_plane_spacing`, Plane spacing sous Geometry). Chacun est une dalle de l'epaisseur de ses barres, centree sur son plan ; dans le plan, chaque membre est une capsule large comme la barre, autour de sa ligne moyenne. Les membres des deux mecanismes ne sont compares que si les dalles s'approchent a moins du jeu demande. Ce qui peut traverser vers l'autre plan, c'est la tige du pivot chariot et le bloc chariot entre les plans. La tige est comptee des qu'elle a une longueur, sauf si le bout chariot du pendule en une piece est encastre ; sa moitie cote chariot pointe vers l'autre dalle, et dans le plan c'est un disque. Le bloc a une largeur a travers les plans, une longueur, une hauteur le long de la course, et le decalage de son centre au-dela des tiges, en s'eloignant du mur d'ancrage du tube A (Carriage block). Chacun n'est verifie dans le plan, contre les membres qu'il peut toucher, que s'il s'approche a moins de `assembly_clearance` (Assembly clearance, 0,3 mm suppose) de leur dalle. S'il reste un jeu a travers les plans, l'ecart est ce jeu compose avec l'ecart dans le plan quand les contours ne se recouvrent pas, et ce jeu seul quand ils se recouvrent ; sans jeu a travers, seul l'ecart dans le plan compte. Le second mecanisme est le premier retourne d'un demi-tour autour du pivot chariot a Y = 0, vu a -Y. L'Explorer donne l'ecart a travers les plans et, quand un controle a lieu, le moindre jeu et l'endroit, plus le premier |Y| ou ce jeu passe sous celui demande s'il y en a un. Il calcule la geometrie meme quand elle ne s'assemble pas. Pour tout objectif autre que Follow target, le Finder coupe le trajet la ou ce jeu n'est plus tenu, au tirage rigide comme au passage en poutre, puis revoit la geometrie retenue sur le jeu de `compute_linkage`. Un membre contre son propre mecanisme, les tubes, les murs ou la vis n'est pas verifie. Le sur-pincement du tube ferme n'est contraint que sur le trajet utilise. Pour ces objectifs, si le plein debit est atteint, la course retournee est ce trajet arrondi vers le haut au pas de 0,05 mm, et seulement s'il tient encore sous le trajet maximum, la portee des barres dans les deux sens, la limite de sur-pincement et le jeu entre les deux mecanismes ; sinon c'est le plus grand pas de 0,05 mm que ces limites laissent, arrondi vers le bas. Elle ne depasse pas le trajet maximum de la recherche. Follow target vise la courbe cible sur toute la course, et ne la garde que si le jeu entre les deux mecanismes est tenu partout sur cette course. Le resultat indique le trajet jusqu'au premier debit, la bande morte (affichee dans les deux sens), le debit statique atteint et sa part du plein alesage, la pente moyenne et la pente max `dQ/dY` sur la montee, la courbure moyenne `d²Q/dY²` sur l'interieur de cette montee (hors coin d'ouverture et hors palier), et le temps jusqu'au plein debit a la vitesse lineaire chargee. Si le volume de chambre est positif, il indique aussi les temps de montee a 50 % et a 90 % de la pression d'alimentation. Un profil par type de mecanisme garde ensemble les reglages de l'Explorer, les plages du Finder et le reglage d'axes des graphiques ; il s'ouvre et s'enregistre depuis la pastille Profile de l'en-tete, la meme dans les deux sous-onglets (`/api/profiles`, type `elbow`, `lever` ou `pendulum`). Sans ces reglages, chaque axe s'ouvre en Auto. Forces a la pression reglee : moindre force pour sceller (pion juste ferme, sans precharge), et force du pion a Y = 0, precharge comprise (pliage du tube, ecrasement des parois, air ; en `fem` ces trois parts sortent de la section, en `simple` l'ecrasement suit la compliance). Poussee de vis requise contre poussee disponible du moteur (couple, frottement du filet), recul du pion par flexion des barres et pression que le scellement tient encore. Sous Limits, Seal at rest (`require_seal`) est coche par defaut, y compris pour un `search` de profil ou du navigateur enregistre avant ce champ, et pour chaque objectif. Le Finder refuse alors une geometrie dont le tube ferme fuit a Y = 0 une fois les pieces flechies (`sealed_after_flex` faux). Sans chiffres de force, ce verdict reste vide et la geometrie n'est pas refusee pour fuite : pour les barres, compliance nulle en modele `simple`, pion sans diametre et sans patin, ou section ou module non positif ; pour la piece monobloc, compliance nulle en `simple`, ou pion sans diametre et sans patin. L'Explorer calcule ces geometries quand meme. `/api/linkage/optimize` recoit `require_seal` ; absent, il vaut vrai. Avec cette limite, le choix rigide ne s'arrete pas au paquet du dernier tour : il reprend aussi des geometries ecartees sur les plages, parce que ce paquet est fait de copies qui fuient ou tiennent ensemble. Que la limite soit cochee ou non, chaque geometrie que ce choix retient est re-notee une fois ses cotes arrondies au micrometre, et ecartee seulement si cette pose n'a plus de note. Des qu'un pion atteint la paroi a travers le tube ferme, la force, la flexion et la poussee ne sont plus donnees a partir de ce trajet, dans les deux sens (`/api/linkage/simulate`, `/api/linkage/optimize`). Ecrasement du tube : a chaque position, le tube ecrase repousse le pion jusqu'a l'equilibre avec la flexion des barres ; le debit, la bande morte et le temps de reponse utilisent l'ecart qui en resulte (interrupteur Tube pushes the pin back ; l'optimiseur cherche encore sur barres rigides). Le schema place le pion (et le patin du pendule) ainsi que le tube dessous a l'ecart charge lu par les etiquettes et la carte. Pour le pendule en une piece, deja trace dans sa pose chargee, seul le complement d'ecart encore manquant est applique. Il dessine ce tube deforme et les barres a leur largeur reelle. En `fem`, l'alesage le long du tube est celui de la section a l'ecart local pion-paroi, et il se ferme avant que la paroi externe cesse de bouger ; les epaulements de chaque cote du pion sont schematiques, la section resolue n'ayant pas de flexion le long du tube. En `simple`, les parois gardent leur epaisseur. Pendule : sous Geometry, Link shape regle le lien r entre le joint et le pivot chariot, sur la pose a Y = 0. Le pendule part sur Tangent, Continue foot. Straight est la barre droite. Tangent est l'arc de cercle tangent au pied au joint : Continue foot (`link_curve_flip` faux) part le long de -f, dans le prolongement du pied au-dela du joint ; Opposite part le long de +f, vers le pion. Les deux arcs ont le meme rayon et des ventres opposes, et leurs demi-angles font 180 degres, donc l'un des deux depasse 90 degres des que l'autre ne fait pas exactement 90. Custom radius est l'arc mineur du rayon demande (`link_radius`) : Inward (screw) ventre vers la vis (`link_arc_side` +1), Outward (tube) vers le tube (-1). Un rayon plus court que la demi-corde est ramene au demi-cercle, et c'est ce rayon qui est retenu. Un pied sans longueur, deja aligne sur le lien, ou un rayon non positif laisse le lien droit. Le coude et le levier restent droits. Sur barres pivotees, le lien reste une barre articulee de corde egale a sa longueur : la cinematique du pincement ne change pas, et la traction le long de la corde flechit l'arc, qui entre dans la raideur au pion et dans les contraintes. En une piece, cet arc est la fibre moyenne de la poutre, et le cote du ventre en fait partie. Un `link_curve_mode` vide suit l'ancien `link_curved` (vrai : Tangent et Continue foot, faux : Straight), y compris un profil ou un etat du navigateur enregistre avant ce champ. `/api/linkage/simulate` recoit `link_curve_mode` (`straight`, `tangent`, `radius`, ou vide), `link_curve_flip` et `link_radius` (0 a 1000). Un autre mode, ou un rayon hors borne, repond 422. Absents, ils valent vide, faux et 10. Sous Geometry to search, Link shape vaut Keep current (`current`, defaut : la forme reglee dans l'Explorer), Straight, Tangent (foot), Tangent (flipped), Custom radius ou Search all. Custom radius et Search all cherchent le rayon personnalise des deux cotes, dans Arc radius (`link_radius_min`, `link_radius_max`) : le plancher du tirage est la plus grande valeur entre le bas de la plage, 0,1 mm et la demi-corde, et un haut de plage plus bas que ce plancher laisse ce plancher. Les deux bornes inversees sont remises dans l'ordre. Au passage rigide qui compare plusieurs formes, chaque geometrie retenue est notee, pour le rayon, a ce plancher, au milieu geometrique et au haut de plage. En une piece, le rayon est tire au hasard en logarithme entre ce plancher et le haut, puis resserre autour des meilleurs. Straight, Tangent (foot) et Tangent (flipped) imposent cette seule forme a toute la recherche. Keep current garde celle de l'Explorer, rayon compris, et le tirage rigide compte alors l'arc dans le jeu. Quand plusieurs formes ou un rayon sont cherches, ce tirage rigide note d'abord un lien droit, pour qu'un jeu d'une forme n'ecarte pas une geometrie qu'une autre forme assemble, puis les geometries retenues sont notees sur les formes cherchees. `/api/linkage/optimize` recoit `link_curve_search` (`current`, `all`, `straight`, `tangent`, `tangent_flip`, `radius` ; une autre valeur repond 422), `link_radius_min` et `link_radius_max` (strictement positifs, au plus 1000 ; hors borne, 422). Absents, comme un `search` de profil ou du navigateur enregistre avant eux, ils valent `current`, 5 et 40. Pendule en une piece (One piece, built into the shell) : bras, pied et lien forment une seule piece encastree dans la coque a l'ancrage, sans pivot ; le chariot la fait flechir. Le schema dessine les lignes moyennes flechies de cette piece, sans les pivots. Modele de poutres en petites deformations (`_Flexure`, `_frame_solve`) : la piece est fabriquee dans sa forme a Y = 0, et chaque pose est la somme de deux formes, celle que donne 1 mm de course sans tube et celle que donne 1 N sur le pion. Il en sort le gain du pion, la raideur au pion, la poussee de vis pour flechir les deux pieces, la contrainte le long de la piece contre la resistance du materiau (Material strength, 40 MPa suppose), le troncon ou elle est la pire (bras, pied ou lien) et si ce pic est a la coque, au joint, au chariot ou ailleurs sur ce troncon, le trajet ou elle est depassee et la plus grande rotation (au-dela d'environ 10 degres le modele derive). Cote chariot, le lien tourne sur une tige d'acier (1,5 x 8 mm par defaut), seul vrai pivot de la piece ; l'interrupteur Carriage end clamped l'encastre a la place. Avec la tige, la charge sur la tige, la pression dans l'oeil du lien et la flexion de la tige sont donnees. La tige est moitie dans le chariot, moitie dans l'oeil du lien : pression = charge / (diametre x demi-longueur), flexion a la face du chariot avec la charge au milieu de l'oeil. Les conges et les concentrations de contrainte aux jonctions ne sont pas modelises. Au-dela du trajet ou le pion de cette piece atteint la paroi, la contrainte n'est plus donnee, comme la force. Quand le tube repousse le pion, ce trajet est celui de l'ecart qui reste une fois la piece flechie : une piece trop souple n'ecrase pas le tube ferme jusqu'a la paroi, et il n'y a pas de blocage. L'optimiseur propose cinq objectifs, choisis sous Goal (`response` Fast response par defaut : compromis bande morte minimale, pente de debit `dQ/dY`, debit reel et course courte ; `deadband` Min deadband ; `chamber` Fastest chamber : les finalistes verifies sont notes sur le temps de montee 0→90 % de la chambre, mais le tirage rigide classe encore sur la bande morte, la pente, le debit et la course, et ce temps n'entre qu'a la verification ; `progressive` courbure `d²Q/dY²` et bande morte basse — en piece monobloc la forme de la poutre est lineaire en course, donc la courbure du debit ne vient pas de la geometrie des barres : elle vient du contact et, en `fem`, de la loi de section ; avec des pivots, la geometrie des barres s'y ajoute ; `target` Follow target). `/api/linkage/optimize` recoit `objective` (une autre valeur repond 422) et `min_flow_pct` (0 a 95, part minimale du debit statique de plein alesage sur la course utilisee ; 0 n'impose rien ; hors borne, 422). Absents, comme un `search` de profil ou du navigateur enregistre avant eux, ils valent `response` et 0. Ce plancher ne note que les quatre objectifs qui choisissent la course : Follow target peut le recevoir et ne s'en sert pas. Le curseur Min flow reached du Finder, visible seulement pour ces quatre, s'arrete a 90. En pendule une piece, il combine des tirages rigides et des tirages que la pose au repos accepte, puis les resout dans le modele de poutre (environ 320 resolutions : jusqu'a 140 au premier passage, puis quatre tours d'au plus 45 tirages resserres autour des meilleures et des extremes de bande morte et de debit, et Search both relance ce passage sur chaque cote). Ce compte vaut pour une seule forme de lien. Search all et Custom radius allongent le premier passage et chacun des quatre tours. Il les classe selon l'objectif actif, sur l'ecart charge et sur le trajet que la piece peut vraiment utiliser : la course utilisable est automatiquement plafonnee sous chaque limite active (contrainte sous la resistance du materiau, poussee de vis sous celle du moteur, pression dans l'oeil sous la resistance du materiau, flexion de la tige sous sa propre resistance de 300 MPa, jeu d'assemblage, sur-pincement et blocage) au lieu de rejeter une geometrie rapide qui ne depasse une limite qu'au-dela de sa course sure. Les meilleurs finalistes sont verifies en pleine resolution et renvoyes en liste Pareto d'au plus dix (`candidates`), barres rigides comme piece monobloc, avec le facteur qui borne la course (`limiting_factor`) et, sur chaque ligne, la pente moyenne, la courbure moyenne et un temps de montee 0→90 % estime vite. Quand plusieurs formes de lien ont ete cherchees, deux dessins dont le `link_curve` differe ne sont pas confondus, et la liste garde la meilleure de chaque forme (droite, tangente, tangente inversee, rayon vers la vis, rayon vers le tube) tant qu'il reste une place dans ces dix. Le temps a 50 % n'est pas calcule sur cette ligne : il sort du cycle de chambre complet du resultat simule, quand le volume est positif. En piece monobloc le rapport compte aussi les ecarts par limite. Le Finder montre la liste des qu'elle a plus d'une ligne ; un clic pose cette geometrie a l'ecran, et Revert rend celle d'avant la recherche. Si aucune piece ne tient, il ne propose rien et dit quelle limite a ecarte chaque geometrie (no_flow : aucun trajet qui ouvre le tube au-dela du seuil demande sans bloquer ni trop pincer le tube ferme ; collision : les deux pieces passent sous le jeu, a moins de 0,05 mm du repos en course automatique, ou n'importe ou sur la course en Follow target, et le controle de la course retenue ecarte celle qui en contient encore ; seal : Seal at rest, et le tube ferme fuit a Y = 0 une fois la piece flechie). Materiau des barres : une liste deroulante regle d'un coup le module et la resistance (PETG 2 500 / 40 MPa et PLA 3 500 / 50 MPa fournis, valeurs indicatives pour des pieces imprimees) ; des valeurs reglees a la main s'enregistrent sous un nom comme materiau personnalise, garde cote serveur et commun aux trois mecanismes (`/api/linkage/materials`). Bouton Write to Onshape variables : ecrit les dimensions a l'ecran dans une table de variables (Variable Studio) propre au simulateur, trouvee par son nom dans le document configure (`cam_sim_<type>` par defaut, champ Variable table name), creee si elle n'existe pas ; dans une table existante, seules les lignes cochees changent et les variables ajoutees a la main restent, et une Part Studio n'utilise ces valeurs qu'une fois la table referencee a la main. Quand `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID` est defini, l'apercu relit ce Part Studio pour chaque variable qu'il enverrait, et une ecriture qui aboutit le relit pour les lignes cochees ecrites, ajoutees ou deja egales. Une variable locale du meme nom remplace la table. Une ecriture en echec ne relit pas, et ce constat ne refuse pas l'ecriture. Sans cet id, ce Part Studio n'est pas lu (`/api/linkage/onshape/preview`, `/api/linkage/onshape/apply`, voir `docs/onshape-export.md`). Entrees mesurees dans le CAD : pour le pendule, le centre du tube (distance de l'axe du tube a l'axe de la vis) est la variable mesuree `pend_CALC_tube_center` du Part Studio dont l'id d'element est `ONSHAPE_LINKAGE_MEASURE_PART_STUDIO_ID`. Le bouton Sync from Onshape sous Tube centre ecrase la valeur du simulateur avec celle d'Onshape. Quand cet id est defini, l'export n'est valide que si la mesure se lit et que la simulation part de cette valeur a 0,001 mm pres. Sinon `/api/linkage/onshape/apply` repond 409 et n'ecrit rien. Sans cet id, rien n'est lu ni verifie (`/api/linkage/onshape/measured`). Un pivot inverse est refuse, a l'apercu comme a l'ecriture (HTTP 409, rien envoye), tant qu'`ONSHAPE_LINKAGE_MAPPING` ne donne pas `pivot_side` a une variable de croquis : les noms par defaut ne l'ont pas, les croquis placent le pivot du cote oppose a la vis, et `pivot_offset` reste une distance positive. Une fois la variable mappee, sa valeur est 1 de ce cote et -1 du cote tube. Un pivot normal n'exige pas cette variable : sans elle, l'ecriture reste celle d'avant (`docs/onshape-export.md`).
- `frontend/`: interface utilisateur React + Recharts. Quatre onglets (Cam, Bar Linkage, Lever Linkage, Pendulum Linkage), chacun avec les sous-onglets Explorer et Finder ; le dernier choix est relu au chargement. Sous Cam, Explorer est la simulation de came et Finder est le Profile Builder : il est monte a la premiere ouverture, puis seulement masque, pour qu'un calcul en cours survive au changement d'onglet. Sauvegarde et import : une seule pastille Profile dans l'en-tete pour chaque onglet et sous-onglet (nom du profil charge ou Unsaved, `*` si modifie, Import, Save as new, Update). Import ouvre une seule fenetre, filtree sur le type de l'onglet ouvert (Cam Explorer `cam`, Cam Finder `cam-finder`, Bar Linkage `elbow`, Lever Linkage `lever`, Pendulum Linkage `pendulum`) : liste avec note et date, recherche, apercu au survol, double-clic ou Open pour charger, suppression, Set as default. Save as new demande un nom et une note ; pour `cam` et `cam-finder`, un nom vide donne un nom genere, et un nom deja present demande confirmation avant d'etre ecrase. Update reecrit le profil charge ; sur un mecanisme, qui n'a pas de champ note, il renvoie la note deja stockee, ou n'ecrit rien si cette lecture echoue. Au chargement, seul le Cam Explorer ouvre le profil par defaut ; les onglets de mecanisme reprennent l'etat de travail garde dans le navigateur. Chaque schema (Explorer et Finder, came comprise) a l'interrupteur Flow particles, a cote d'Oscillate et de Center : un seul etat pour tous les schemas, memorise dans le navigateur (pour cette page seulement si ce stockage est refuse), affiche par defaut. La densite et la vitesse des particules suivent le debit calcule et plafonnent au debit statique du plein alesage. Sur un mecanisme cette reference est `max_flow_l_min` (aire du plein alesage ; le modele statique est lineaire en section). Sur la came, c'est le debit par unite de section du plus grand echantillon ouvert, ramene a cette aire ; sans echantillon ouvert, aucune particule. Reference nulle ou debit nul : aucune particule n'est visible et aucune ne bouge, aussitot, y compris pendant Oscillate. En vue de cote (mecanisme), une particule tient dans l'alesage encore ouvert sur toute sa hauteur et reste a l'ecart des extremites coupees ; la chambre n'est pas dessinee, elle est prise sous le dessin, donc l'air descend le tube A (alimentation) et monte le tube B (echappement). En coupe (came), l'air traverse le tube perpendiculairement a l'ecran, dans l'alesage de la section FEM a l'ecart affiche, ou dans le creneau du modele `simple`, dont l'aire est l'aire de debit simulee. Si le navigateur demande `prefers-reduced-motion: reduce`, les particules gardent la meme densite et restent immobiles.
- `simulation_came.py`: script standalone (visualisation matplotlib) pour test local rapide.
- `backend/data/simulator.db`: base de donnees de persistance (configs + extension future solver/profile builder).

## Prerequis

- Python 3.10+
- Node.js 20+ (npm inclus)

## Quick start

### 1) Lancer le backend (Terminal 1)

Depuis la racine du projet:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install fastapi "uvicorn[standard]" numpy matplotlib
uvicorn backend.main:app --reload --reload-dir backend --host 0.0.0.0 --port 8001
```

Backend disponible sur: `http://localhost:8001`

`backend/Dockerfile` fixe `OPENBLAS_NUM_THREADS` et `OMP_NUM_THREADS` a 1 : les resolutions denses du cadre et de la section de tube disputent un pool de threads BLAS, et cela ralentit la recherche des qu'il y a plusieurs coeurs. L'image les pose ; les commandes `uvicorn` locales, ici et plus bas, non. Les exporter avant `uvicorn` quand une recherche chauffe.

Test rapide:

```powershell
curl http://localhost:8001/api/health
```

### 2) Lancer le frontend (Terminal 2)

Creer/mettre a jour `frontend/.env.local` pour pointer le frontend vers le backend:

```powershell
Set-Content -Path .\frontend\.env.local -Value "VITE_API_BASE_URL=http://localhost:8001"
```

Le frontend depend du package prive `@blain-projects/ui` (registry GitHub
Packages). Avant `npm install`, exporter un token avec droit `read:packages` :

```powershell
$env:NODE_AUTH_TOKEN = "<github-pat-read-packages>"
```

`frontend/.npmrc` pointe `@blain-projects` vers `npm.pkg.github.com` et lit
`${NODE_AUTH_TOKEN}`. Meme variable pour un build Docker Compose, passee comme
secret BuildKit `npm_token` (`secrets:` → `frontend/Dockerfile`), jamais en
build-arg.

```powershell
cd frontend
npm install
npm run dev
```

Frontend disponible sur: `http://localhost:5173`

Chrome UI partage (header full-width, theme, champs kit, `SiteFooter`
sous l'outil plein ecran, labels en sentence case, kit
`@blain-projects/ui` ^3.3.1, surfaces plates et motion 250 ms,
attentes Solve / export STL via `Button.loading` / `LoadingState` / `Loader`) : voir
[`docs/ui-uniformity-2026-10-08.md`](docs/ui-uniformity-2026-10-08.md).
En Docker, passer `APP_VERSION` / `APP_COMMIT` / `APP_COMMIT_DATE` au build
frontend pour peupler le pied de page (pas de `.git` dans l'image) — voir
le commentaire dans `docker-compose.yml`.

## Demarrer toute la stack ensuite

Apres la premiere installation:

Terminal 1 (backend):

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn backend.main:app --reload --reload-dir backend --host 0.0.0.0 --port 8001
```

Terminal 2 (frontend):

```powershell
cd frontend
npm run dev
```

## Option: lancer la simulation standalone

Si vous voulez tester uniquement le modele Python avec generation de figure:

```powershell
.\.venv\Scripts\Activate.ps1
python simulation_came.py
```

Image generee: `simulation_came_profile.png`

## Endpoints utiles

- `POST /api/simulate`: lance une simulation avec les parametres fournis.
- `GET /api/configs`: liste les configs sauvegardees.
- `POST /api/save-config`: sauvegarde la config courante.
- `GET /api/builder-experiences`: liste les experiences Profile Builder sauvegardees.
- `POST /api/builder-experiences`: enregistre une experience solver (combinaisons candidates + note + contexte).
- `GET /api/export/stl-config`: etat de la pipeline d'export STL Onshape (cles + identifiants de document).
- `POST /api/export/stl-stream`: NDJSON stream — pousse la config vers Onshape, lance la traduction STL, retourne `download_url`.
- `GET /api/export/stl-download/{job_id}`: one-shot — telecharge le binaire STL produit (cache 10 min).
- `GET /api/health`: verification rapide du backend.
- `POST /api/tube/sweep`: balayage FEM d'un tube (quarts de contour, force, aire ouverte) sur ses distances de plaques, demande une fois par tube. La carte Tube section et les schemas interpolent la section a la distance courante. `POST /api/tube/section` renvoie encore la section ecrasee a une distance `h`. L'interface lit le balayage.

Profils : une seule table SQLite `profiles` (type `cam`, `cam-finder`, `elbow`, `lever`, `pendulum`, un profil par defaut par type), servie par `/api/profiles?type=`, `/api/profiles/{type}/{name}`, `POST /api/profiles/{type}` et `/api/profiles/{type}/default`. Les routes `/api/configs`, `/api/save-config`, `/api/builder-experiences` et `/api/linkage/profiles` lisent et ecrivent la meme table. Au premier demarrage, les anciennes tables `simulation_configs`, `builder_experiences` et `linkage_profiles` y sont copiees une fois, puis laissees telles quelles ; les materiaux personnalises restent dans `linkage_profiles`.

La pression d'alimentation est en kPa, au-dessus de l'atmosphere (`input_pressure_kpa` pour la came, le solveur, l'export STL et les mecanismes ; `pressureKpa` dans l'etat du Profile Builder ; `seal_pressure_y0_kpa` pour la pression que le scellement tient encore a Y = 0). Un corps de requete ou un profil lu en base qui porte encore `input_pressure_psi`, `seal_pressure_y0_psi` ou `pressurePsi` est converti par `backend/legacy_units.py` ; si l'ancien champ et le nouveau sont tous les deux la, le kPa est garde. Cette lecture ne reecrit pas la ligne : l'enregistrement suivant stocke des kPa. L'import des `configs/*.json` convertit avant d'inserer un profil absent, sans modifier le fichier ni un profil deja present. Dans le navigateur (`frontend/src/lib/pressure.ts`), l'etat de linkage est converti au chargement puis reecrit, et un profil de came charge passe par `mergeConfigParams` (`frontend/src/components.tsx`), qui applique la meme conversion en memoire.

## Export STL via Onshape

Bouton **Export STL** dans le header → `StlExportModal` qui suit en direct
chaque etape (auth, push des variables, traduction) avec une progress bar et
un log granulaire. Quand le backend a fini, le STL reste en cache (~10 min) :
il faut cliquer **Download STL** pour declencher `window.showSaveFilePicker`
(geste utilisateur requis ; fallback `<a download>` si l'API absente).

Le backend reutilise le skill OpenClaw `onshape`
(`~/.openclaw/workspace/skills/onshape/`) : meme schema HMAC, meme workflow
de translation, mais embarque directement dans `backend/onshape_export.py`
pour rester portable en Docker.

Configuration requise (voir [`docs/onshape-export.md`](docs/onshape-export.md)) :

```env
ONSHAPE_ACCESS_KEY=...
ONSHAPE_SECRET_KEY=...
ONSHAPE_DOCUMENT_ID=...
ONSHAPE_WORKSPACE_ID=...
ONSHAPE_ELEMENT_ID=...
```

## Rampe de fermeture optionnelle

Le toggle **Closure ramp**, dans l'Explorer de l'onglet Cam et dans le Profile Builder (le Finder de cet onglet), remplace le
plateau cote fermeture par une rampe sur ses 10 mm existants. `ramp_enabled`
est sauvegarde avec les configurations et les experiences; les anciennes
configurations conservent le plateau par defaut.

Avec `Y_join = -deadband/2` et `Y_closed = Y_join - 10`, le decalage de came
vaut 0 mm a `Y_closed` et `default_distance` a `Y_join`. La rampe utilise
`default_distance × (3u² - 2u³)`, ou `u = (Y - Y_closed)/10`, pour rejoindre
tangentiellement la courbe d'ouverture inchangee. Les axes actuels sont
conserves : Y croissant ouvre le tube. Les graphiques montrent toute la rampe.

Le gap physique reste la distance minimale bushing/came plus le jeu radial
de 0,25 mm. La rampe tient compte du contact avec les segments du profil,
et non seulement de l'ecart horizontal a la meme coordonnee Y. Ce gap est la
distance entre plaques passee a la loi du tube. En `tube_model` `fem`
(defaut), l'aire de debit est l'aire ouverte de la section, nulle des que le
gap est inferieur ou egal a la distance de fermeture contre la pression
reglee. En `simple`, le debit est nul si
`gap <= OD - ID - compliance × pression_MPa`. Le seuil depend donc du tube
et de la pression ; un decalage geometrique nul ne force pas un debit nul.
La compliance n'ouvre le tube qu'en `simple`. La simulation de came utilise
cette aire pour le debit et ne calcule pas de force de contact sur la came :
la force par millimetre affichee est celle de la carte Tube section et, sur
un mecanisme, celle du pincement.

Le sketch Onshape actuel supporte uniquement le plateau. L'export STL en mode
rampe est bloque explicitement jusqu'a ce que le sketch CAD reproduise ce mode.

Validation numerique : `python -m unittest discover -s backend/tests -v`.

## Tube par elements finis

Le tube pince est resolu par elements finis dans `backend/tube_fem/`, un paquet qui n'importe rien de l'application (numpy seulement). Dans le plan normal a l'axe du tube, le pion (ou la came et la bague) et la paroi sont deux plaques planes paralleles a une distance `h` : chaque tranche du tube est un anneau ecrase entre deux plaques. Le modele resout cet anneau en deformation plane, grandes deformations, silicone neo-hookeen presque incompressible (module de Young tire de la durete Shore A par la relation de Gent, coefficient de Poisson 0,4995, soit un module de compressibilite environ 1000 fois le module de cisaillement, comme le silicone), elements quadratiques a 9 noeuds avec pression lineaire condensee (pas de verrouillage), contact sans frottement avec la plaque et, par symetrie, un quart de section dont la paroi interieure qui se referme touche le plan median. La pression d'air pousse la paroi du canal encore ouvert : l'ouverture du tube sous pression sort de l'elasticite, sans compliance. Il en sort, en fonction de `h`, la force par mm de tube, sa part due a l'air, l'aire du canal, la distance ou le canal se ferme (sans pression et contre la pression reglee) et la forme deformee. Les reponses sont gardees en memoire et sur disque (`tube_fem_cache`, dans le meme repertoire que le fichier de base : `/app/data` dans l'image, la ou pointe `SIM_DB_PATH`). Le seul lien avec le reste est `backend/tube_model.py` ; l'interrupteur `tube_model` (`fem` par defaut, ou `simple` pour l'ancienne loi de compliance) est dans les parametres de la came, du solveur et des mecanismes, avec `tube_shore_a` (50 par defaut). Limites : pas de frottement (plaques ni canal), pas d'effets axiaux (la flexion du tube le long de son axe a cote d'un pion etroit reste une allocation forfaitaire de OD/2 dans le mecanisme, et chaque tranche est resolue seule), pas de viscoelasticite ni d'effet Mullins, pas de raidissement du silicone aux grands allongements, et un tube neo-hookeen gonfle sans limite vers mu ln(OD/ID) de pression (environ 330 kPa en Shore 50, 3 x 2 mm) : au-dela, une erreur claire. Le modele n'a pas ete compare a un tube mesure ; E vient de la durete par une relation empirique, donc les forces absolues portent cette incertitude (dizaines de pourcents). Au-dela de 40 % d'ecrasement apres la fermeture, la force est extrapolee. Pour retirer le modele : supprimer `backend/tube_fem/` et `backend/tube_model.py`, les branches `uses_fem` (came, solveur, mecanismes, `POST /api/tube/section` et `POST /api/tube/sweep`), puis `frontend/src/TubeModel.tsx`, `frontend/src/lib/tubeModel.ts`, `frontend/src/lib/tubeSweep.ts`, `frontend/src/lib/tubeSide.ts` et leurs imports dans `App.tsx`, `LinkageExplorer.tsx`, `ProfileBuilder.tsx` et `components.tsx`. Validation : `python -m unittest backend.tests.test_tube_fem` (Lame, anneau entre deux plaques, convergence de maillage, incompressibilite, bande ecrasee, penetration du contact).

La carte Tube section est dans la colonne de graphiques de l'Explorer came, du Profile Builder et de chaque onglet mecanisme, Finder compris. Elle suit le chariot image par image. `h` y est l'ecart came-bague a la position Y affichee, ou l'ecart charge du tube A (l'ecart rigide quand le tube ne repousse pas le pion). En Auto, le cadre est celui du tube et s'ouvre au-dela du premier contact pour garder les plaques. Sous le plus petit `h` resolu, la carte aplatit la section la plus ecrasee jusqu'a `h`, prend la force extrapolee, et l'indique. L'alesage est ferme a la distance de fermeture et en dessous. Le Profile Builder garde l'interrupteur et le Shore A ; sa carte, son schema et les simulations de candidats utilisent la pression, le tube et le modele du calcul affiche. En `simple`, la carte ne dessine pas la section et demande de revenir a FEM. Les schemas de came dessinent cette section a l'ecart affiche, entre deux plaques planes, donc elle ne suit pas la courbure de la bague ni de la came ; en `simple` ils gardent le creneau dont l'aire est l'aire de debit. Pendant qu'un nouveau tube se resout, les schemas gardent le dernier balayage FEM et la carte attend. Un profil enregistre sans `tube_model` s'ouvre en `fem` (`mergeConfigParams` pour la came, `cleanTubeModel` pour un mecanisme) : la compliance reste stockee et ne sert que si l'interrupteur passe sur `simple`. Pour un mecanisme, la marque plein debit (`full_open_gap`) est la distance pion-paroi ou l'aire ouverte revient a 95 % de l'aire du canal non charge (`FULL_OPEN_FRACTION` dans `backend/tube_model.py`). La came plafonne l'aire de debit a l'aire du canal rond, `pi (ID/2)^2`, comme en `simple`.

## Alignement avec le template `web_projects/`

Ce projet suit la meme structure que `web_projects/web_projects_template/` :
`backend/` (FastAPI), `frontend/` (Vite + React 19), `docker-compose.yml`
branche sur `web_network`, `.env` pour les secrets, `docs/` pour la
documentation longue. Pour la communication avec les agents OpenClaw
(Makey, Codey, etc.), voir [`web_projects_template/OPENCLAW.md`](../web_projects_template/OPENCLAW.md).

## Notes

- Le frontend utilise `VITE_API_BASE_URL` (fichier `frontend/.env.local`).
- Valeur recommandee: `http://localhost:8001`.
- Les configurations sont stockees en base SQLite (`SIM_DB_PATH` optionnel pour surcharger le chemin).
