/**
 * Lifecycle utility helpers that scenes and plugins can use to describe their startup/shutdown hooks.
 */
export type Dispose = () => void | Promise<void>;

export class Disposable {
  private disposers: Dispose[] = [];

  collect(dispose: Dispose): void {
    this.disposers.push(dispose);
  }

  async run(): Promise<void> {
    for (const dispose of this.disposers.reverse()) {
      await dispose();
    }
    this.disposers = [];
  }
}
