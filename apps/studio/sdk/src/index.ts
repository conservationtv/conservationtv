export * from './generated/index.js';
export * from './versions/index.js';
export { DeviceIdentity, deviceSignature } from './device.js';
export {
  bearer,
  ForbiddenError,
  HandshakeError,
  HandshakeRequiredError,
  HttpError,
  NotAuthorizedError,
  NotFoundError,
  OperationVersionChangedError,
  OperationVersionUnavailableError,
  ValidationError,
  type Authenticate,
  type ClientConfig,
  type VersionedCall,
  type VersionedOperation
} from '@conservationtv/versioned-api/client';
