export function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}
