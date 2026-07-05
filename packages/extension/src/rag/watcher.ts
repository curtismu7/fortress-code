export class Debouncer {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private delayMs: number, private flush: (paths: string[]) => void) {}
  add(path: string): void {
    this.pending.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      this.timer = null;
      this.flush(paths);
    }, this.delayMs);
  }
}
