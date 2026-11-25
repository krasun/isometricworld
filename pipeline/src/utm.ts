/**
 * Transverse Mercator on GRS80 <-> lat/lon, Krüger series to 4th order (sub-mm within a zone): ETRS89 / UTM
 * (EPSG:25832 for zone 32) and any other TM grid given by its parameters. The difference between GRS80
 * and WGS84 is far below a render pixel.
 */
const A = 6378137, F = 1 / 298.257222101;
/** A Transverse Mercator grid: scale on the central meridian, central meridian (deg), false easting/northing (m). */
export interface Tm { k0: number; lon0: number; fe: number; fn: number }
/** UTM zone (north). */
export const utmZone = (zone: number): Tm => ({ k0: 0.9996, lon0: zone * 6 - 183, fe: 500000, fn: 0 });
const n = F / (2 - F), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
const AA = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
const alpha = [n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4, (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4, (61 / 240) * n3 - (103 / 140) * n4, (49561 / 161280) * n4];
const beta = [n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4, (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4, (17 / 480) * n3 - (37 / 840) * n4, (4397 / 161280) * n4];
const delta = [2 * n - (2 / 3) * n2 - 2 * n3 + (116 / 45) * n4, (7 / 3) * n2 - (8 / 5) * n3 - (227 / 45) * n4, (56 / 15) * n3 - (136 / 35) * n4, (4279 / 630) * n4];
const e = Math.sqrt(F * (2 - F));
const rad = Math.PI / 180;

/** lat/lon (deg) -> [easting, northing] in the given UTM zone (north). */
export const toUtm = (lat: number, lon: number, zone = 32) => toTm(lat, lon, utmZone(zone));
/** [easting, northing] in the given UTM zone (north) -> [lat, lon] (deg). */
export const fromUtm = (east: number, north: number, zone = 32) => fromTm(east, north, utmZone(zone));

/** lat/lon (deg) -> [easting, northing] on a TM grid. */
export function toTm(lat: number, lon: number, p: Tm): [number, number] {
  const φ = lat * rad, λ = (lon - p.lon0) * rad;
  const t = Math.sinh(Math.atanh(Math.sin(φ)) - e * Math.atanh(e * Math.sin(φ)));
  const ξ = Math.atan2(t, Math.cos(λ)), η = Math.atanh(Math.sin(λ) / Math.sqrt(1 + t * t));
  let x = η, y = ξ;
  for (let j = 1; j <= 4; j++) {
    x += alpha[j - 1] * Math.cos(2 * j * ξ) * Math.sinh(2 * j * η);
    y += alpha[j - 1] * Math.sin(2 * j * ξ) * Math.cosh(2 * j * η);
  }
  return [p.fe + p.k0 * AA * x, p.fn + p.k0 * AA * y];
}

/** [easting, northing] on a TM grid -> [lat, lon] (deg). */
export function fromTm(east: number, north: number, p: Tm): [number, number] {
  const ξ = (north - p.fn) / (p.k0 * AA), η = (east - p.fe) / (p.k0 * AA);
  let ξ1 = ξ, η1 = η;
  for (let j = 1; j <= 4; j++) {
    ξ1 -= beta[j - 1] * Math.sin(2 * j * ξ) * Math.cosh(2 * j * η);
    η1 -= beta[j - 1] * Math.cos(2 * j * ξ) * Math.sinh(2 * j * η);
  }
  const χ = Math.asin(Math.sin(ξ1) / Math.cosh(η1));
  let φ = χ;
  for (let j = 1; j <= 4; j++) φ += delta[j - 1] * Math.sin(2 * j * χ);
  const λ = Math.atan2(Math.sinh(η1), Math.cos(ξ1));
  return [φ / rad, λ / rad + p.lon0];
}
