/**
 * Runs tasks one at a time per key, in arrival order. Used so a person's messages are handled in the
 * order they were sent even when one of them (a voice note) takes seconds to transcribe.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const result = prev.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
