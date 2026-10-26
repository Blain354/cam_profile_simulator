/**
 * Âge lisible d'une date `YYYY-MM-DD` (« il y a 2 j »), pour le commit déployé
 * du SiteFooter. Reprend la logique de home_blain-projects (age.ts).
 */
export function ageOf(isoDay: string, now: Date = new Date()): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}/.test(isoDay)) return undefined
  // Midi UTC des deux côtés : un écart de fuseau ne doit pas décaler d'un jour.
  const then = Date.UTC(+isoDay.slice(0, 4), +isoDay.slice(5, 7) - 1, +isoDay.slice(8, 10), 12)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const days = Math.max(0, Math.round((today - then) / 86_400_000))
  if (days === 0) return 'aujourd’hui'
  if (days === 1) return 'hier'
  if (days < 60) return `il y a ${days} j`
  if (days < 365) return `il y a ${Math.floor(days / 30.44)} mois`
  const years = Math.floor(days / 365.25) || 1
  return `il y a ${years} an${years > 1 ? 's' : ''}`
}
