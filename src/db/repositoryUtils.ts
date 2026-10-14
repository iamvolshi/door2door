
/** Shared utility: generate a UTC ISO string for createdAt/updatedAt timestamps. */
export function nowISO(): string {
  return new Date().toISOString();
}
