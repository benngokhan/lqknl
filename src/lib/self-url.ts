/**
 * Sunucunun kendisine yaptığı iç HTTP çağrıları için hedef.
 *
 * NEDEN: `new URL(req.url).origin` (ör. https://aimira.up.railway.app) üzerinden
 * container → dış edge → container dönüşü, Railway'in hairpin/idle edge davranışına
 * takılabiliyor (uzun isteklerde "fetch failed"). Aynı süreç zaten 0.0.0.0:PORT'ta
 * dinliyor; loopback (127.0.0.1) edge'i tamamen devre dışı bırakır.
 */
export function selfOrigin(): string {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}
