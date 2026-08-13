/**
 * `JSON.stringify` estoura em `bigint`, e o schema usa bigint em todo lugar
 * (lamports, base units). Este helper converte para string — nunca para
 * `Number`, que perderia precisão acima de 2^53.
 */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, val: unknown) => (typeof val === 'bigint' ? val.toString() : val)),
  );
}
