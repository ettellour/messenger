export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
