// Sanitización anti-inyección de fórmulas en exportaciones a Excel/CSV
// (B5/B9, v5.3.26). Un valor que empieza por = + - @ (o tabulador /
// retorno de carro) se interpreta como fórmula al abrir el archivo en
// Excel o Sheets: un cliente llamado `=cmd|'/C calc'!A0` ejecutaría
// código en el equipo de quien abre el archivo. Prefijar con apóstrofe
// (') lo marca como texto: Excel lo muestra igual pero no lo ejecuta.
// Los números y el resto de valores pasan tal cual.
export function sanitizeExcelCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.replace(/^[\s\uFEFF]+/, '');
  if (/^[=+\-@\t\r]/.test(trimmed)) return `'${value}`;
  return value;
}

/** Sanitiza un objeto fila (json_to_sheet): cada valor pasa por
 * sanitizeExcelCell; las claves quedan igual. */
export function sanitizeExcelRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = sanitizeExcelCell(v);
  return out as T;
}
