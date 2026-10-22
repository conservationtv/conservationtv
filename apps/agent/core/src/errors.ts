/** A change the spec can't take as it stands, such as a path for a MediaMTX that isn't running. */
export class SpecConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecConflict';
  }
}
