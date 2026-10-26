
## Version de l'app

`frontend/package.json` → `version` est affichée dans le SiteFooter (avec le commit
déployé). Point de départ fixé le 2026-10-26 lors de la migration Liquid 2, estimé
d'après la quantité de travail. À chaque changement livré, l'agent l'incrémente
en semver, dans le même commit que le changement : correctif → patch,
fonctionnalité → minor, refonte ou rupture → major
(`npm version <patch|minor|major> --no-git-tag-version` dans `frontend/`).
