/** One successful initialization per DO instance/build. Concurrent requests
 * share the same work; a failed storage initialization is never cached. */
export class SchemaInitialization {
  private pending: Promise<void> | null = null;
  run(initialize: () => Promise<void>): Promise<void> {
    if (!this.pending) {
      this.pending = Promise.resolve().then(initialize).catch(error => {
        this.pending = null;
        throw error;
      });
    }
    return this.pending;
  }
}
