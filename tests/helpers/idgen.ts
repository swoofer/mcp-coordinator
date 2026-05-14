/**
 * Seeded deterministic id generator. Use in tests that want reproducible
 * IDs (e.g. snapshot tests, cross-tenant matrices) instead of crypto.randomUUID.
 * Pad-to-6 keeps lexicographic order matching numeric order for up to 999_999
 * ids per IdGen instance — plenty for any single test.
 */
export class IdGen {
  private counter = 0;
  constructor(private readonly prefix: string = "test") {}
  next(): string {
    this.counter++;
    return `${this.prefix}-${this.counter.toString().padStart(6, "0")}`;
  }
  reset(): void {
    this.counter = 0;
  }
}
