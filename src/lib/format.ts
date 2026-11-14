export function money(n: number | null | undefined, currency: 'usd' | 'eur' = 'usd'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const symbol = currency === 'usd' ? 'US$' : '€';
  return `${symbol}${n.toFixed(2)}`;
}

export function rarityLabel(r: string): string {
  switch (r) {
    case 'common':
      return 'Común';
    case 'uncommon':
      return 'Infrecuente';
    case 'rare':
      return 'Rara';
    case 'mythic':
      return 'Mítica';
    case 'special':
      return 'Especial';
    case 'bonus':
      return 'Bonus';
    default:
      return r;
  }
}

export function rarityShort(r: string): string {
  switch (r) {
    case 'common':
      return 'C';
    case 'uncommon':
      return 'U';
    case 'rare':
      return 'R';
    case 'mythic':
      return 'M';
    default:
      return r.slice(0, 1).toUpperCase();
  }
}

export function year(date: string): string {
  return date ? date.slice(0, 4) : '';
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}
