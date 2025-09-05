// backend/utils/ccBands.js
export const CC_BANDS = [
  { key: "0-1300",     min: 0,    max: 1300 },
  { key: "1301-1800",  min: 1301, max: 1800 },
  { key: "1801-2400",  min: 1801, max: 2400 },
  { key: "2401-3000",  min: 2401, max: 3000 },
  { key: "3001+",      min: 3001, max: 99999 }
];

export function findBandForCC(cc) {
  const n = Number(cc);
  if (!Number.isFinite(n)) return null;
  const band = CC_BANDS.find(b => n >= b.min && n <= b.max);
  return band ? band.key : null;
}
