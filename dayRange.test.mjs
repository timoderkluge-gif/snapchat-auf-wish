// node dayRange.test.mjs  — self-check for the date logic (copy of dayRange in App.js)
import assert from 'node:assert';
function dayRange(today, yearsAgo, daysBack = 0) {
  const start = new Date(today.getFullYear() - yearsAgo, today.getMonth(), today.getDate() - daysBack);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return [start.getTime(), end.getTime()];
}
const [s, e] = dayRange(new Date(2026, 10, 9, 15, 30), 3);
assert.deepStrictEqual(new Date(s), new Date(2023, 10, 9));
assert.deepStrictEqual(new Date(e), new Date(2023, 10, 10));
assert.deepStrictEqual(new Date(dayRange(new Date(2024, 1, 29), 1)[0]), new Date(2023, 2, 1));
// 7 Tage zurück über den Monatswechsel: 3. März 2026 -> 24. Februar 2025
assert.deepStrictEqual(new Date(dayRange(new Date(2026, 2, 3), 1, 7)[0]), new Date(2025, 1, 24));
console.log('ok');
