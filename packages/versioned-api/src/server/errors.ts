export class NotFoundError extends Error {}

/** The client asked for a version of an operation that this server doesn't serve. `served` is empty if versionless. */
export class OperationVersionMismatchError extends Error {
  readonly operationId: string;
  readonly served: readonly number[];

  constructor(operationId: string, served: readonly number[], requested: string) {
    super(
      served.length === 0
        ? `${operationId} is versionless, so it has no version ${requested}`
        : `${operationId} is served at version ${served.join(', ')}, not ${requested}`
    );
    this.operationId = operationId;
    this.served = served;
  }
}
