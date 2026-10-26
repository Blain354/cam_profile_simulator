/**
 * Identité du projet affichée par le SiteFooter ; version et commit viennent
 * du build (build-meta.ts).
 */
export const project = {
  name: "Cam Profile Simulator",
  tagline: "Simulation d'un profil de came pour l'ouverture d'une valve pneumatique.",
  createdAt: '2026-04-07', // date du premier commit
  // TODO(guillaume): licence — à confirmer.
  maintainer: 'Guillaume Blain',
  // TODO(guillaume): contact (adresse publique à afficher).
  hosting: 'Traefik · Docker',
  repoUrl: 'https://github.com/Blain354/cam_profile_simulator',
  branch: 'main',
}

/**
 * Mode vitrine (courants + lentille) : app privée, donc sobre par défaut.
 * VITE_BLAIN_SHOWOFF=true|false (build arg) l'emporte s'il est posé.
 */
export const isShowOff = () => {
  const value = import.meta.env.VITE_BLAIN_SHOWOFF
  return value ? value === 'true' : false
}
